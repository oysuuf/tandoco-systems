/* ════════════════════════════════════════════════════════════════════
   SMS segment math — GSM-7 / UCS-2 detection + segment count.

   Mirrors the logic in scripts/hq-v2-sms-composer.js so the server's
   recorded segment count matches what the operator sees in HQ before
   saving a dry-run. Kept as a separate small module because Phase 9b
   and Phase 9c both need it, and it's easy to unit-test in isolation.
   ════════════════════════════════════════════════════════════════════ */

'use strict';

const GSM_BASIC = '@£$¥èéùìòÇ\nØø\rÅå\u0394_\u03A6\u0393\u039B\u03A9\u03A0\u03A8\u03A3\u0398\u039EÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const GSM_EXT = '\f^{}\\[~]|€';

function isGsm7(text){
  for (let i = 0; i < text.length; i++){
    const c = text.charAt(i);
    if (GSM_BASIC.indexOf(c) === -1 && GSM_EXT.indexOf(c) === -1) return false;
  }
  return true;
}

function countLength(text){
  if (!isGsm7(text)) return { length: text.length, encoding: 'UCS-2' };
  let len = 0;
  for (let i = 0; i < text.length; i++){
    len += (GSM_EXT.indexOf(text.charAt(i)) !== -1) ? 2 : 1;
  }
  return { length: len, encoding: 'GSM-7' };
}

/** @returns {{segments:number, length:number, encoding:string, capacity:number}} */
function computeSegments(text){
  const m = countLength(text);
  if (m.length === 0) return { segments: 0, length: 0, capacity: 160, encoding: m.encoding };
  const single = m.encoding === 'GSM-7' ? 160 : 70;
  const multi  = m.encoding === 'GSM-7' ? 153 : 67;
  if (m.length <= single) return { segments: 1, length: m.length, capacity: single, encoding: m.encoding };
  return { segments: Math.ceil(m.length / multi), length: m.length, capacity: multi, encoding: m.encoding };
}

module.exports = { computeSegments, countLength, isGsm7 };
