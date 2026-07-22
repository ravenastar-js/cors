/**
 * 🌐 Cloudflare Worker - CORS Proxy com Rate Limit
 * @author RavenaStar
 * @version 1.1.0
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
    /** 🛡️ Domínios autorizados a usar o proxy (whitelist) — sem barra final */
    ALLOWED_ORIGINS: [
        'https://seudominio.com',
        'https://www.seudominio.com',
        'http://localhost:3000',
        'http://localhost:5500',
        'http://localhost:8080'
    ],
    /** 🚫 User-Agents bloqueados (bots/scrapers) — apenas heurística auxiliar, não é controle de segurança */
    BLOCKED_AGENTS: [
        'Postman',
        'curl',
        'python-requests',
        'Go-http-client',
        'node-fetch',
        'axios',
        'insomnia',
        'bruno'
    ],
    /** ⛔ Hosts de destino bloqueados (comparação exata de hostname, não substring) */
    BLOCKED_HOSTS: [
        'proxy.corsfix.com',
        'api.allorigins.win',
        'cors.isomorphic-git.org'
    ],
    /** 🔁 Máximo de redirects seguidos manualmente */
    MAX_REDIRECTS: 5
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

            // 📡 Identifica o cliente (apenas o header injetado pela própria Cloudflare é confiável)
            const clientIP = request.headers.get('CF-Connecting-IP') || 'unknown';

            const origin = request.headers.get('Origin') || '';
            const userAgent = request.headers.get('User-Agent') || '';

            // 🛡️ Verifica se a origem é autorizada (comparação exata, não startsWith)
            if (!this._isOriginAllowed(origin)) {
                return this._errorResponse(
                    '🔒 Origem não autorizada. Apenas domínios permitidos.',
                    403
                );
            }

            // 🤖 Bloqueia bots conhecidos (heurística auxiliar — não é a única barreira)
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

            let parsedTarget;
            try {
                parsedTarget = new URL(targetUrl);
            } catch (_) {
                return this._errorResponse('⚠️ URL inválida. Deve começar com http:// ou https://', 400);
            }

            if (parsedTarget.protocol !== 'http:' && parsedTarget.protocol !== 'https:') {
                return this._errorResponse('⚠️ URL inválida. Deve começar com http:// ou https://', 400);
            }

            // 🚫 Bloqueia hosts internos/privados e proxies encadeados (checagem exata de hostname)
            const hostCheck = this._isHostBlocked(parsedTarget.hostname);
            if (hostCheck) {
                return this._errorResponse('⛔ Destino não permitido por segurança.', 403);
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

            // 🌐 Proxy da requisição (com validação manual de cada redirect)
            const response = await this._proxyRequest(parsedTarget.toString(), request);
            if (response instanceof Response && response.status >= 300 && response._blockedRedirect) {
                return this._errorResponse('⛔ Redirecionamento para destino não permitido.', 403);
            }

            const responseData = await response.text();

            return this._successResponse(responseData, rateCheck.remaining);

        } catch (error) {
            console.error('❌ Erro no proxy:', error);
            return this._errorResponse('💥 Erro interno do servidor. Tente novamente mais tarde.', 500);
        }
    },

    /**
     * 🛡️ Verifica se a origem bate exatamente com um item da whitelist
     * @param {string} origin - Header Origin da requisição
     * @returns {boolean}
     */
    _isOriginAllowed(origin) {
        if (!origin) return false;
        try {
            const originUrl = new URL(origin);
            return CONFIG.ALLOWED_ORIGINS.some(allowed => {
                const allowedUrl = new URL(allowed);
                return originUrl.protocol === allowedUrl.protocol &&
                    originUrl.host === allowedUrl.host;
            });
        } catch (_) {
            return false;
        }
    },

    /**
     * ⛔ Verifica se o hostname de destino é bloqueado (proxies encadeados, loopback, redes privadas)
     * @param {string} hostname - Hostname de destino
     * @returns {boolean}
     */
    _isHostBlocked(hostname) {
        const host = hostname.toLowerCase();
        
        if (CONFIG.BLOCKED_HOSTS.includes(host)) return true;
        if (host === 'localhost' || host === '0.0.0.0' || host.endsWith('.local')) return true;

        const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
        
        if (ipv4) {
            const [a, b] = [parseInt(ipv4[1], 10), parseInt(ipv4[2], 10)];
            if (a === 127) return true;
            if (a === 10) return true;
            if (a === 192 && b === 168) return true;
            if (a === 172 && b >= 16 && b <= 31) return true;
            if (a === 169 && b === 254) return true;
        }

        if (host === '::1' || host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) return true;
        return false;
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
     * 🌐 Proxy da requisição, seguindo redirects manualmente e validando cada host
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

        let body;
        let method = 'GET';

        if (request.method === 'POST') {
            try {
                const raw = await request.clone().text();
                if (raw) {
                    headers.set('Content-Type', 'application/json');
                    body = raw;
                    method = 'POST';
                }
            } catch (_) { /* ignora */ }
        }

        let currentUrl = targetUrl;
        for (let i = 0; i <= CONFIG.MAX_REDIRECTS; i++) {
            const res = await fetch(currentUrl, {
                method,
                headers,
                body,
                redirect: 'manual'
            });

            if (res.status >= 300 && res.status < 400 && res.headers.get('Location')) {
                const nextUrl = new URL(res.headers.get('Location'), currentUrl);
                if (this._isHostBlocked(nextUrl.hostname)) {
                    const blocked = new Response(null, { status: 403 });
                    blocked._blockedRedirect = true;
                    return blocked;
                }
                currentUrl = nextUrl.toString();
                continue;
            }

            return res;
        }

        return this._errorResponse('⛔ Excesso de redirecionamentos.', 400);
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
