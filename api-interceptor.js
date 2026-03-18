/**
 * api-interceptor.js — MAIN world content script that intercepts Google Flow's
 * fetch/XHR API calls to capture auth context and response data.
 *
 * Runs in the PAGE's JavaScript context (not the extension's isolated world),
 * so it has access to window.fetch but NOT chrome.runtime. Communication with
 * the extension happens exclusively via window.postMessage.
 */

(function () {
  'use strict';

  /* ============================================================
     CONSTANTS
     ============================================================ */

  const LOG_PREFIX = '[FlowAuto:API]';
  const MSG_PREFIX = 'GFLOW_';
  const TRPC_PATH = '/fx/api/trpc/';
  const IMAGE_URL_PATTERN = /https?:\/\/[^\s"']+\.(?:png|jpg|jpeg|webp|gif)(?:\?[^\s"']*)?/gi;
  const IMAGE_FIELD_NAMES = [
    'imageUrl', 'image_url', 'url', 'src', 'uri',
    'thumbnailUrl', 'thumbnail_url', 'outputUrl', 'output_url',
    'generatedImage', 'generated_image', 'resultUrl', 'result_url'
  ];

  /* ============================================================
     STATE
     ============================================================ */

  /** Captured auth headers from intercepted outgoing requests. */
  const authContext = {
    headers: {},
    cookies: '',
    lastCapturedAt: null
  };

  /**
   * Registry of observed tRPC procedure calls.
   * Maps procedure name -> { method, url, bodyShape, lastSeen }.
   */
  const trpcRegistry = {};

  /** Most recently discovered image URLs from responses. */
  const discoveredImages = [];

  /** Maximum number of images to keep in the buffer. */
  const MAX_IMAGE_BUFFER = 200;

  /* ============================================================
     LOGGING
     ============================================================ */

  function log(msg, ...args) {
    console.log(`${LOG_PREFIX} ${msg}`, ...args);
  }

  function warn(msg, ...args) {
    console.warn(`${LOG_PREFIX} ${msg}`, ...args);
  }

  /* ============================================================
     MESSAGING HELPERS
     ============================================================ */

  /**
   * Post a message to the extension's content script (isolated world).
   * All messages are prefixed with GFLOW_ so the content script can filter.
   */
  function postToExtension(type, payload) {
    window.postMessage({
      type: MSG_PREFIX + type,
      payload: payload,
      timestamp: Date.now()
    }, '*');
  }

  /* ============================================================
     AUTH CAPTURE
     ============================================================ */

  /**
   * Extract auth-relevant headers from a fetch Request or raw headers object.
   * Captures cookies, CSRF tokens, authorization headers, and Google-specific
   * headers that are needed to replay API calls.
   */
  function captureAuthHeaders(headers) {
    const captured = {};
    const authHeaderNames = [
      'cookie', 'authorization', 'x-csrf-token', 'x-csrftoken',
      'x-xsrf-token', 'x-requested-with', 'x-goog-authuser',
      'x-goog-request-info', 'x-same-domain', 'x-framework-xsrf-token',
      'x-client-data', 'content-type', 'x-goog-api-key',
      'x-youtube-client-name', 'x-origin'
    ];

    if (headers instanceof Headers) {
      for (const name of authHeaderNames) {
        const val = headers.get(name);
        if (val) captured[name] = val;
      }
    } else if (headers && typeof headers === 'object') {
      // Plain object or array of [key, value] pairs
      const entries = Array.isArray(headers)
        ? headers
        : Object.entries(headers);
      for (const [key, value] of entries) {
        if (authHeaderNames.includes(key.toLowerCase())) {
          captured[key.toLowerCase()] = value;
        }
      }
    }

    return captured;
  }

  /**
   * Merge newly captured headers into the persistent authContext.
   */
  function updateAuthContext(headers, url) {
    const captured = captureAuthHeaders(headers);
    if (Object.keys(captured).length > 0) {
      Object.assign(authContext.headers, captured);
      authContext.cookies = document.cookie || '';
      authContext.lastCapturedAt = Date.now();
      authContext.lastUrl = url;

      log('Auth context updated — %d header(s) captured.', Object.keys(authContext.headers).length);
      postToExtension('AUTH_UPDATED', {
        headerCount: Object.keys(authContext.headers).length,
        capturedAt: authContext.lastCapturedAt
      });
    }
  }

  /* ============================================================
     tRPC REGISTRY
     ============================================================ */

  /**
   * Parse a tRPC URL to extract the procedure name(s).
   * tRPC URLs look like: /fx/api/trpc/procedure.name or
   * /fx/api/trpc/proc1,proc2 (batch calls).
   */
  function parseTrpcProcedure(url) {
    try {
      const urlObj = new URL(url, window.location.origin);
      const pathAfterTrpc = urlObj.pathname.split(TRPC_PATH)[1];
      if (!pathAfterTrpc) return [];
      // May be comma-separated for batch calls
      return pathAfterTrpc.split(',').map(p => p.trim()).filter(Boolean);
    } catch (e) {
      return [];
    }
  }

  /**
   * Register an observed tRPC call pattern.
   */
  function registerTrpcCall(url, method, body) {
    const procedures = parseTrpcProcedure(url);
    for (const proc of procedures) {
      trpcRegistry[proc] = {
        method: method,
        url: url,
        bodyShape: body ? summarizeBody(body) : null,
        lastSeen: Date.now()
      };
    }
    if (procedures.length > 0) {
      log('tRPC procedures registered: %s', procedures.join(', '));
    }
  }

  /**
   * Create a shallow summary of a request body (for pattern discovery).
   * Does not store actual values — only keys and types.
   */
  function summarizeBody(body) {
    try {
      const parsed = typeof body === 'string' ? JSON.parse(body) : body;
      return extractShape(parsed);
    } catch (e) {
      return typeof body;
    }
  }

  function extractShape(obj) {
    if (obj === null) return 'null';
    if (Array.isArray(obj)) {
      return obj.length > 0 ? ['Array', extractShape(obj[0])] : ['Array'];
    }
    if (typeof obj === 'object') {
      const shape = {};
      for (const key of Object.keys(obj)) {
        shape[key] = extractShape(obj[key]);
      }
      return shape;
    }
    return typeof obj;
  }

  /* ============================================================
     IMAGE URL EXTRACTION
     ============================================================ */

  /**
   * Recursively search a parsed JSON response for image URLs.
   * Returns an array of URL strings.
   */
  function extractImageUrls(data, depth) {
    depth = depth || 0;
    if (depth > 15) return [];

    const urls = [];

    if (typeof data === 'string') {
      // Check if the string itself is an image URL
      const matches = data.match(IMAGE_URL_PATTERN);
      if (matches) {
        urls.push(...matches);
      }
      return urls;
    }

    if (Array.isArray(data)) {
      for (const item of data) {
        urls.push(...extractImageUrls(item, depth + 1));
      }
      return urls;
    }

    if (data && typeof data === 'object') {
      for (const key of Object.keys(data)) {
        // Prioritise known image field names
        if (IMAGE_FIELD_NAMES.includes(key) && typeof data[key] === 'string') {
          urls.push(data[key]);
        } else {
          urls.push(...extractImageUrls(data[key], depth + 1));
        }
      }
    }

    return urls;
  }

  /**
   * Buffer discovered image URLs and notify the extension.
   */
  function storeDiscoveredImages(urls, procedureName) {
    if (!urls || urls.length === 0) return;

    // Deduplicate against existing buffer
    const newUrls = urls.filter(u => !discoveredImages.some(d => d.url === u));
    for (const url of newUrls) {
      discoveredImages.push({
        url: url,
        procedure: procedureName,
        discoveredAt: Date.now()
      });
    }

    // Trim buffer
    while (discoveredImages.length > MAX_IMAGE_BUFFER) {
      discoveredImages.shift();
    }

    if (newUrls.length > 0) {
      log('Discovered %d new image URL(s) from %s', newUrls.length, procedureName || 'unknown');
      postToExtension('IMAGES_DISCOVERED', {
        newUrls: newUrls,
        totalBuffered: discoveredImages.length,
        procedure: procedureName
      });
    }
  }

  /* ============================================================
     FETCH MONKEY-PATCH
     ============================================================ */

  const originalFetch = window.fetch;

  window.fetch = function patchedFetch(input, init) {
    // Extract URL synchronously — NEVER await anything before calling originalFetch
    var url = '';
    var method = 'GET';
    try {
      if (input instanceof Request) {
        url = input.url;
        method = input.method || 'GET';
      } else {
        url = (typeof input === 'string') ? input : String(input);
        method = (init && init.method) ? init.method.toUpperCase() : 'GET';
      }
    } catch (e) {
      return originalFetch.apply(this, arguments);
    }

    var isTrpc = url.includes(TRPC_PATH);

    // Capture auth headers synchronously (non-blocking)
    if (isTrpc) {
      try {
        var headers = (input instanceof Request) ? input.headers : (init && init.headers);
        if (headers) updateAuthContext(headers, url);
        if (init && init.headers && init.headers !== headers) {
          updateAuthContext(init.headers, url);
        }

        // Register procedure pattern (body not needed for registration)
        registerTrpcCall(url, method, null);

        postToExtension('TRPC_REQUEST', {
          url: url,
          method: method,
          procedures: parseTrpcProcedure(url),
          timestamp: Date.now()
        });
      } catch (e) {
        warn('Error in pre-fetch interception:', e);
      }
    }

    // Call original fetch IMMEDIATELY — no awaits before this
    var fetchPromise = originalFetch.apply(this, arguments);

    // Only intercept response for tRPC calls, and do it non-blocking
    if (isTrpc) {
      fetchPromise.then(function (response) {
        if (response.ok) {
          try {
            var clonedResponse = response.clone();
            clonedResponse.json().then(function (jsonData) {
              var procedures = parseTrpcProcedure(url);
              var procedureName = procedures.join(',') || 'unknown';
              var imageUrls = extractImageUrls(jsonData);
              storeDiscoveredImages(imageUrls, procedureName);

              postToExtension('TRPC_RESPONSE', {
                url: url,
                procedures: procedures,
                status: response.status,
                hasImages: imageUrls.length > 0,
                imageCount: imageUrls.length,
                timestamp: Date.now()
              });
            }).catch(function () {
              // Not valid JSON — ignore
            });
          } catch (e) {
            // Ignore cloning errors
          }
        }
      }).catch(function (fetchError) {
        postToExtension('TRPC_ERROR', {
          url: url,
          error: fetchError.message,
          timestamp: Date.now()
        });
      });
    }

    // Return the ORIGINAL promise — caller gets the untouched response
    return fetchPromise;
  };

  /* ============================================================
     API PROMPT SUBMISSION
     ============================================================ */

  /**
   * Submit a prompt directly via the tRPC API using captured auth context.
   * This bypasses React's contenteditable entirely.
   *
   * @param {string} prompt - The prompt text to submit.
   * @param {object} options - Optional overrides: { procedure, url, extraBody }.
   * @returns {Promise<object>} The API response data.
   */
  async function submitPromptViaApi(prompt, options) {
    options = options || {};

    if (!authContext.lastCapturedAt) {
      throw new Error('No auth context captured yet. Make at least one request on the page first.');
    }

    // Find the best procedure to use for submission.
    // Look for common generation-related tRPC procedure names.
    const generationKeywords = [
      'generate', 'create', 'submit', 'prompt', 'imagine',
      'predict', 'run', 'execute', 'infer', 'completion'
    ];
    let targetProcedure = options.procedure || null;
    let targetUrl = options.url || null;
    let targetMethod = 'POST';

    if (!targetProcedure) {
      // Search the registry for a procedure that looks like generation
      for (const [procName, info] of Object.entries(trpcRegistry)) {
        const lowerName = procName.toLowerCase();
        if (generationKeywords.some(kw => lowerName.includes(kw))) {
          targetProcedure = procName;
          targetUrl = info.url;
          targetMethod = info.method || 'POST';
          break;
        }
      }
    }

    if (!targetUrl && targetProcedure) {
      // Construct a URL from the procedure name
      targetUrl = TRPC_PATH + targetProcedure;
    }

    if (!targetUrl) {
      // Last resort: use any mutation (POST) call we've seen
      for (const [procName, info] of Object.entries(trpcRegistry)) {
        if (info.method === 'POST') {
          targetProcedure = procName;
          targetUrl = info.url;
          targetMethod = 'POST';
          break;
        }
      }
    }

    if (!targetUrl) {
      throw new Error(
        'No suitable tRPC endpoint discovered. The interceptor needs to observe ' +
        'at least one generation request before it can replay. Please submit a ' +
        'prompt manually first.'
      );
    }

    // Build the request body.
    // tRPC mutation bodies typically look like: { "0": { "json": { ... } } }
    const requestBody = options.extraBody
      ? JSON.stringify(options.extraBody)
      : JSON.stringify({
          '0': {
            json: {
              prompt: prompt,
              text: prompt
            }
          }
        });

    // Build headers from captured auth context
    const requestHeaders = Object.assign({}, authContext.headers);
    if (!requestHeaders['content-type']) {
      requestHeaders['content-type'] = 'application/json';
    }

    log('Submitting prompt via API to %s (%s)', targetUrl, targetProcedure);

    // Use the ORIGINAL fetch to avoid re-intercepting our own call
    const response = await originalFetch(targetUrl, {
      method: targetMethod,
      headers: requestHeaders,
      body: requestBody,
      credentials: 'include'
    });

    let responseData = null;
    try {
      responseData = await response.clone().json();
    } catch (e) {
      responseData = await response.clone().text();
    }

    const result = {
      ok: response.ok,
      status: response.status,
      procedure: targetProcedure,
      data: responseData
    };

    // Extract any image URLs from the response
    if (response.ok && responseData) {
      const imageUrls = extractImageUrls(responseData);
      storeDiscoveredImages(imageUrls, targetProcedure);
      result.imageUrls = imageUrls;
    }

    return result;
  }

  /* ============================================================
     WINDOW MESSAGE LISTENER
     ============================================================ */

  window.addEventListener('message', async function (event) {
    // Only accept messages from the same window (content script posts here)
    if (event.source !== window) return;
    if (!event.data || typeof event.data.type !== 'string') return;

    const type = event.data.type;
    const payload = event.data.payload || {};

    switch (type) {

      case 'GFLOW_SUBMIT_PROMPT': {
        log('Received SUBMIT_PROMPT command: "%s"',
          (payload.prompt || '').substring(0, 60));
        try {
          const result = await submitPromptViaApi(
            payload.prompt,
            {
              procedure: payload.procedure || null,
              url: payload.url || null,
              extraBody: payload.body || null
            }
          );
          postToExtension('SUBMIT_RESULT', {
            success: result.ok,
            status: result.status,
            procedure: result.procedure,
            imageUrls: result.imageUrls || [],
            data: result.data,
            requestId: payload.requestId || null
          });
        } catch (err) {
          warn('API prompt submission failed:', err);
          postToExtension('SUBMIT_RESULT', {
            success: false,
            error: err.message,
            requestId: payload.requestId || null
          });
        }
        break;
      }

      case 'GFLOW_GET_AUTH': {
        log('Received GET_AUTH request.');
        postToExtension('AUTH_CONTEXT', {
          headers: authContext.headers,
          cookies: authContext.cookies,
          lastCapturedAt: authContext.lastCapturedAt,
          lastUrl: authContext.lastUrl,
          trpcRegistry: Object.keys(trpcRegistry).map(function (name) {
            return {
              name: name,
              method: trpcRegistry[name].method,
              bodyShape: trpcRegistry[name].bodyShape,
              lastSeen: trpcRegistry[name].lastSeen
            };
          }),
          discoveredImageCount: discoveredImages.length,
          requestId: payload.requestId || null
        });
        break;
      }

      default:
        // Ignore messages that don't match our command types
        break;
    }
  });

  /* ============================================================
     INITIALISATION
     ============================================================ */

  // Capture initial cookies
  authContext.cookies = document.cookie || '';

  log('API interceptor installed. Monitoring %s endpoints.', TRPC_PATH);

  // Announce readiness to the extension's content script
  postToExtension('INTERCEPTOR_READY', {
    timestamp: Date.now(),
    trpcPath: TRPC_PATH
  });

})();
