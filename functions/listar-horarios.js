/**
 * GET /listar-horarios — Edge Function (Cloudflare Pages)
 * Alias direto para /api/listar-horarios.
 */
export { onRequestGet, onRequestOptions } from "./api/listar-horarios.js";
