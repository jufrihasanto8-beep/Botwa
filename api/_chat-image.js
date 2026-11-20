/**
 * Chat Image Generator — render chat messages jadi PNG (mirip screenshot WA)
 * Dipakai untuk forward feedback customer bermasalah ke grup ekspedisi
 *
 * Usage: const pngBuffer = await generateChatImage(messages, customerName)
 */

let _satori, _Resvg, _fontData;

async function loadDeps() {
  if (!_satori) { const s = require('satori'); _satori = s.default || s; }
  if (!_Resvg) _Resvg = require('@resvg/resvg-js').Resvg;
  if (!_fontData) {
    // Fetch font static TTF (satori ga support woff2/variable fonts)
    const fontUrls = [
      'https://github.com/google/fonts/raw/main/ofl/inter/static/Inter-Regular.ttf',
      'https://cdn.jsdelivr.net/fontsource/fonts/inter@latest/latin-400-normal.ttf',
      'https://github.com/rsms/inter/raw/master/docs/font-files/Inter-Regular.otf',
    ];
    for (const url of fontUrls) {
      try {
        const res = await fetch(url, { redirect: 'follow' });
        if (res.ok) { _fontData = await res.arrayBuffer(); break; }
      } catch { /* try next */ }
    }
  }
}

/**
 * Generate PNG screenshot of chat
 * @param {Array} messages - [{role:'customer'|'ai'|'cs', isi:string, created_at:string}]
 * @param {string} customerName
 * @param {string} resi - nomor resi
 * @param {string} ekspedisi - nama kurir
 * @returns {Buffer} PNG buffer
 */
async function generateChatImage(messages, customerName, resi, ekspedisi) {
  await loadDeps();

  const WIDTH = 420;
  const PADDING = 16;
  const BUBBLE_MAX = 300;

  // Build chat elements
  const chatElements = [];

  // Header
  chatElements.push({
    type: 'div',
    props: {
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        padding: '12px 16px',
        background: '#075E54',
        color: '#fff',
        borderRadius: '12px 12px 0 0',
      },
      children: [
        {
          type: 'div',
          props: {
            style: { width: '36px', height: '36px', borderRadius: '18px', background: '#25D366', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '16px', fontWeight: '700', color: '#fff' },
            children: (customerName || '?')[0].toUpperCase(),
          },
        },
        {
          type: 'div',
          props: {
            style: { display: 'flex', flexDirection: 'column' },
            children: [
              { type: 'div', props: { style: { fontSize: '14px', fontWeight: '700' }, children: customerName || 'Customer' } },
              { type: 'div', props: { style: { fontSize: '10px', opacity: '0.8' }, children: `${resi || ''} · ${ekspedisi || ''}` } },
            ],
          },
        },
      ],
    },
  });

  // Chat body
  const bubbles = [];
  for (const msg of messages) {
    const isCustomer = msg.role === 'customer';
    const time = msg.created_at
      ? new Date(msg.created_at).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jakarta' })
      : '';

    const text = (msg.isi || '').slice(0, 300);
    const label = isCustomer ? null : (msg.role === 'cs' ? 'CS' : 'Bot');

    const bubbleChildren = [];
    if (label) {
      bubbleChildren.push({
        type: 'span',
        props: {
          style: { fontSize: '10px', fontWeight: '700', color: isCustomer ? '#075E54' : '#6366f1', marginBottom: '2px' },
          children: label,
        },
      });
    }
    bubbleChildren.push({
      type: 'span',
      props: { style: { fontSize: '13px', lineHeight: '1.4', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }, children: text },
    });
    bubbleChildren.push({
      type: 'span',
      props: {
        style: { fontSize: '10px', color: isCustomer ? '#667781' : 'rgba(255,255,255,0.6)', alignSelf: 'flex-end', marginTop: '2px' },
        children: time,
      },
    });

    bubbles.push({
      type: 'div',
      props: {
        style: {
          display: 'flex',
          justifyContent: isCustomer ? 'flex-start' : 'flex-end',
          padding: '2px 0',
        },
        children: {
          type: 'div',
          props: {
            style: {
              display: 'flex',
              flexDirection: 'column',
              maxWidth: `${BUBBLE_MAX}px`,
              padding: '8px 10px',
              borderRadius: isCustomer ? '4px 12px 12px 12px' : '12px 4px 12px 12px',
              background: isCustomer ? '#fff' : '#005C4B',
              color: isCustomer ? '#111b21' : '#e9edef',
              boxShadow: '0 1px 1px rgba(0,0,0,0.08)',
            },
            children: bubbleChildren,
          },
        },
      },
    });
  }

  chatElements.push({
    type: 'div',
    props: {
      style: {
        display: 'flex',
        flexDirection: 'column',
        padding: `${PADDING}px`,
        gap: '4px',
        background: '#ECE5DD',
        borderRadius: '0 0 12px 12px',
        flexGrow: '1',
      },
      children: bubbles,
    },
  });

  const root = {
    type: 'div',
    props: {
      style: {
        display: 'flex',
        flexDirection: 'column',
        width: `${WIDTH}px`,
        fontFamily: 'Inter',
        borderRadius: '12px',
        overflow: 'hidden',
        boxShadow: '0 4px 20px rgba(0,0,0,0.15)',
      },
      children: chatElements,
    },
  };

  // Estimate height: header + messages (avg ~80px per msg, long msgs get more)
  const msgHeights = messages.map(m => {
    const textLen = (m.isi || '').length;
    const lines = Math.ceil(textLen / 30) + (m.isi || '').split('\n').length - 1;
    return Math.max(60, lines * 22 + 40);
  });
  const estimatedHeight = 70 + msgHeights.reduce((a, b) => a + b, 0) + PADDING * 2 + 10;

  const svg = await _satori(root, {
    width: WIDTH,
    height: Math.min(Math.max(estimatedHeight, 200), 1200),
    fonts: [{ name: 'Inter', data: _fontData, weight: 400, style: 'normal' }],
  });

  const resvg = new _Resvg(svg, {
    fitTo: { mode: 'width', value: WIDTH * 2 }, // 2x for retina
  });
  const pngData = resvg.render();
  return pngData.asPng();
}

module.exports = { generateChatImage };
