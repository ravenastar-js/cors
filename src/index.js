/**
 * 🌐 Cloudflare Worker - CORS Proxy com Rate Limit
 * @author RavenaStar
 * @version 1.0.0
 * @license MIT
 * @description Proxy CORS para Cloudflare Workers com rate limit por IP
 * @docs https://developers.cloudflare.com/workers/
 */

/**
 * 🔧 Configurações do Worker
 * Altere estas variáveis conforme sua necessidade
 */
const CONFIG = {
    /** ⏱️ Janela de rate limit em segundos */
    RATE_WINDOW: 60,
    /** 🚦 Limite de requisições por IP por janela */
    RATE_LIMIT: 30,
    /** 🛡️ Domínios autorizados a usar o proxy (whitelist) */
    ALLOWED_ORIGINS: [
        'https://seudominio.com',
        'https://www.seudominio.com',
        'http://localhost:3000',
        'http://localhost:5500',
        'http://localhost:8080'
    ],
    /** 🚫 User-Agents bloqueados (bots/scrapers) */
    BLOCKED_AGENTS: [
        'Postman',
        'curl',
        'python-requests',
        'Go-http-client',
        'node-fetch',
        'axios',
        'insomnia',
        'bruno'
    ]
};

/**
 * 🎯 Handler principal do Worker
 * @param {Request} request - Requisição recebida
 * @param {Object} env - Environment variables (contém o KV)
 * @param {Object} ctx - Execution context
 * @returns {Promise<Response>}
 */
export default {
    async fetch(request, env, ctx) {
        try {
            const url = new URL(request.url);
            const method = request.method;

            // 🔄 Preflight CORS
            if (method === 'OPTIONS') {
                return this._handleCORS();
            }

            // 🚫 Apenas GET e POST são permitidos
            if (method !== 'GET' && method !== 'POST') {
                return this._errorResponse('🚫 Método não permitido. Use GET ou POST.', 405);
            }

            // 📡 Identifica o cliente
            const clientIP = request.headers.get('CF-Connecting-IP') ||
                request.headers.get('X-Forwarded-For')?.split(',')[0] ||
                'unknown';

            const origin = request.headers.get('Origin') || '';
            const userAgent = request.headers.get('User-Agent') || '';

            // 🛡️ Verifica se a origem é autorizada
            const isOriginAllowed = CONFIG.ALLOWED_ORIGINS.some(o => origin.startsWith(o));
            if (!isOriginAllowed) {
                return this._errorResponse(
                    '🔒 Origem não autorizada. Apenas domínios permitidos.',
                    403
                );
            }

            // 🤖 Bloqueia bots conhecidos
            const isBot = CONFIG.BLOCKED_AGENTS.some(agent =>
                userAgent.toLowerCase().includes(agent.toLowerCase())
            );
            if (isBot) {
                return this._errorResponse('🤖 Bot detectado. Acesso negado.', 403);
            }

            // 🔗 Extrai a URL de destino
            let targetUrl = url.searchParams.get('url');
            if (!targetUrl) {
                targetUrl = url.pathname.substring(1) + url.search;
            }

            // ✅ Valida a URL de destino
            if (!targetUrl) {
                return this._errorResponse('❌ URL de destino não fornecida. Use ?url=https://...', 400);
            }

            if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
                return this._errorResponse('⚠️ URL inválida. Deve começar com http:// ou https://', 400);
            }

            // ⛔ Previne proxy encadeado
            const BLOCKED_PROXIES = ['proxy.corsfix.com', 'api.allorigins.win', 'cors.isomorphic-git.org'];
            if (BLOCKED_PROXIES.some(p => targetUrl.includes(p))) {
                return this._errorResponse('⛔ Proxy encadeado não permitido por segurança.', 403);
            }

            // ⏱️ Rate Limit (usa KV se disponível, senão fallback)
            const rateLimitKey = `ratelimit:${clientIP}`;
            const rateCheck = await this._checkRateLimit(rateLimitKey, env);
            if (!rateCheck.allowed) {
                return this._errorResponse(
                    `⏳ Limite excedido. Aguarde ${Math.ceil(rateCheck.retryAfter / 60)} minuto(s).`,
                    429,
                    { 'Retry-After': String(rateCheck.retryAfter) }
                );
            }

            // 🌐 Proxy da requisição
            const response = await this._proxyRequest(targetUrl, request);
            const responseData = await response.text();

            return this._successResponse(responseData, rateCheck.remaining);

        } catch (error) {
            console.error('❌ Erro no proxy:', error);
            return this._errorResponse('💥 Erro interno do servidor. Tente novamente mais tarde.', 500);
        }
    },

    /**
     * 🛡️ Verifica rate limit no KV
     * @param {string} key - Chave do rate limit
     * @param {Object} env - Environment variables
     * @returns {Promise<{allowed: boolean, remaining: number, retryAfter: number}>}
     */
    async _checkRateLimit(key, env) {
        try {
            // 🔍 Verifica se o KV está disponível
            const hasKV = env && env.KV && typeof env.KV.get === 'function';

            if (!hasKV) {
                console.warn('⚠️ KV não configurado. Rate limit desativado.');
                return { allowed: true, remaining: CONFIG.RATE_LIMIT, retryAfter: 0 };
            }

            const data = await env.KV.get(key);
            const now = Math.floor(Date.now() / 1000);

            if (!data) {
                await env.KV.put(key, JSON.stringify({
                    count: 1,
                    windowStart: now
                }), { expirationTtl: CONFIG.RATE_WINDOW });
                return { allowed: true, remaining: CONFIG.RATE_LIMIT - 1, retryAfter: 0 };
            }

            const parsed = JSON.parse(data);
            const elapsed = now - parsed.windowStart;

            if (elapsed >= CONFIG.RATE_WINDOW) {
                await env.KV.put(key, JSON.stringify({
                    count: 1,
                    windowStart: now
                }), { expirationTtl: CONFIG.RATE_WINDOW });
                return { allowed: true, remaining: CONFIG.RATE_LIMIT - 1, retryAfter: 0 };
            }

            const remaining = CONFIG.RATE_LIMIT - parsed.count;
            if (remaining <= 0) {
                const retryAfter = CONFIG.RATE_WINDOW - elapsed;
                return { allowed: false, remaining: 0, retryAfter };
            }

            await env.KV.put(key, JSON.stringify({
                count: parsed.count + 1,
                windowStart: parsed.windowStart
            }), { expirationTtl: CONFIG.RATE_WINDOW });

            return { allowed: true, remaining: remaining - 1, retryAfter: 0 };

        } catch (error) {
            console.warn('⚠️ Erro no rate limit:', error);
            return { allowed: true, remaining: CONFIG.RATE_LIMIT, retryAfter: 0 };
        }
    },

    /**
     * 🌐 Proxy da requisição
     * @param {string} targetUrl - URL de destino
     * @param {Request} request - Requisição original
     * @returns {Promise<Response>}
     */
    async _proxyRequest(targetUrl, request) {
        const headers = new Headers({
            'Accept': 'application/json',
            'Accept-Encoding': 'gzip, deflate, br',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        });

        if (request.method === 'POST') {
            try {
                const body = await request.clone().text();
                if (body) {
                    headers.set('Content-Type', 'application/json');
                    return fetch(targetUrl, {
                        method: 'POST',
                        headers,
                        body
                    });
                }
            } catch (_) { /* ignora */ }
        }

        return fetch(targetUrl, {
            method: 'GET',
            headers,
            redirect: 'follow'
        });
    },

    /**
     * ✅ Resposta de sucesso
     * @param {string} data - Dados da resposta
     * @param {number} remaining - Requisições restantes
     * @returns {Response}
     */
    _successResponse(data, remaining) {
        return new Response(data, {
            status: 200,
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type, Accept',
                'Cache-Control': 'no-cache, no-store, must-revalidate',
                'X-RateLimit-Remaining': String(remaining),
                'X-Proxy': 'CORS-Proxy-Worker'
            }
        });
    },

    /**
     * ❌ Resposta de erro com HTTP.cat
     * @param {string} message - Mensagem de erro
     * @param {number} status - Código HTTP
     * @param {Object} extraHeaders - Headers adicionais
     * @returns {Response}
     */
    _errorResponse(message, status = 400, extraHeaders = {}) {
        const errorMessages = {
            400: '❌ Requisição inválida',
            403: '🔒 Acesso negado',
            405: '🚫 Método não permitido',
            429: '⏳ Muitas requisições',
            500: '💥 Erro interno'
        };

        const httpCatUrl = `https://http.cat/${status}`;

        return new Response(JSON.stringify({
            success: false,
            error: message,
            code: status,
            message: errorMessages[status] || '❌ Erro na requisição',
            timestamp: new Date().toISOString(),
            http_cat: httpCatUrl
        }), {
            status,
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type, Accept',
                'Cache-Control': 'no-cache, no-store, must-revalidate',
                'X-HTTP-Cat': httpCatUrl,
                ...extraHeaders
            }
        });
    },

    /**
     * 🔄 Resposta CORS para preflight
     * @returns {Response}
     */
    _handleCORS() {
        return new Response(null, {
            status: 204,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type, Accept',
                'Access-Control-Max-Age': '86400'
            }
        });
    }
};