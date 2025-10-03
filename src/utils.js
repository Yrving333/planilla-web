export function normalize(str = '') {
  return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}
export function serieFromName(nombres = '', apellidos = '') {
  const s = (nombres.slice(0, 2) + apellidos.slice(0, 2)).toUpperCase();
  return `${s}001`;
}
export function pad5(n) {
  return String(n).padStart(5, '0');
}

