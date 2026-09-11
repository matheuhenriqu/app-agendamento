/**
 * POST /criar-agendamento — Edge Function (Cloudflare Pages)
 * Alias direto para /api/criar-agendamento.
 */
export { onRequestPost, onRequestOptions } from "./api/criar-agendamento.js";
