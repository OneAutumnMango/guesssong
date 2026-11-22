import qrcode from 'qrcode-generator';

export const joinUrl = (publicUrl, code) => publicUrl.replace(/\/$/, '') + '/login?room=' + code;

const QUIET = 4; // modules of white border, required for reliable scanning

export function qrSvg(text) {
  const qr = qrcode(0, 'M'); // type 0 = smallest version that fits
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const size = n + 2 * QUIET;
  let d = '';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + QUIET} ${r + QUIET}h1v1h-1z`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}
