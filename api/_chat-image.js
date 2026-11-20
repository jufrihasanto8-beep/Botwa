/**
 * Chat Image Generator — render chat messages jadi PNG (mirip screenshot WA dark mode)
 * Dipakai untuk forward feedback customer bermasalah ke grup ekspedisi
 *
 * Usage: const pngBuffer = await generateChatImage(messages, customerName, resi, ekspedisi)
 */

let _satori, _Resvg, _fontData;

async function loadDeps() {
  if (!_satori) { const s = require('satori'); _satori = s.default || s; }
  if (!_Resvg) _Resvg = require('@resvg/resvg-js').Resvg;
  if (!_fontData) {
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
 * Generate PNG screenshot of chat — WA dark mode style
 * @param {Array} messages - [{role:'customer'|'ai'|'cs', isi:string, created_at:string}]
 * @param {string} customerName
 * @param {string} resi - nomor resi
 * @param {string} ekspedisi - nama kurir
 * @returns {Buffer} PNG buffer
 */
async function generateChatImage(messages, customerName, resi, ekspedisi) {
  await loadDeps();

  const WIDTH = 390; // phone-width portrait
  const PAD = 12;
  const BUBBLE_MAX = 270;

  // ── Helper: format time WIB ──
  const fmtTime = (dt) => {
    if (!dt) return '';
    return new Date(dt).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jakarta' });
  };

  // ── Helper: date divider (Hari ini / Kemarin / tanggal) ──
  const fmtDate = (dt) => {
    if (!dt) return '';
    const d = new Date(dt);
    const now = new Date();
    const today = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Jakarta' }));
    today.setHours(0, 0, 0, 0);
    const msgDay = new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Jakarta' }));
    msgDay.setHours(0, 0, 0, 0);
    const diff = Math.floor((today - msgDay) / 86400000);
    if (diff === 0) return 'Hari ini';
    if (diff === 1) return 'Kemarin';
    return d.toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Jakarta' });
  };

  // ── Build elements ──
  const elements = [];

  // Header bar — dark WA style
  elements.push({
    type: 'div',
    props: {
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        padding: '10px 14px',
        background: '#1F2C34',
        color: '#e9edef',
      },
      children: [
        // Back arrow
        { type: 'div', props: { style: { fontSize: '18px', color: '#00a884' }, children: '←' } },
        // Avatar circle
        {
          type: 'div',
          props: {
            style: {
              width: '34px', height: '34px', borderRadius: '17px',
              background: '#00a884',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: '15px', fontWeight: '700', color: '#fff',
            },
            children: (customerName || '?')[0].toUpperCase(),
          },
        },
        // Name + resi
        {
          type: 'div',
          props: {
            style: { display: 'flex', flexDirection: 'column', flexGrow: '1' },
            children: [
              { type: 'div', props: { style: { fontSize: '14px', fontWeight: '600', color: '#e9edef' }, children: customerName || 'Customer' } },
              { type: 'div', props: { style: { fontSize: '11px', color: '#8696a0' }, children: resi ? `${resi} · ${ekspedisi || ''}` : 'online' } },
            ],
          },
        },
        // Menu dots
        { type: 'div', props: { style: { fontSize: '16px', color: '#aebac1' }, children: '⋮' } },
      ],
    },
  });

  // Chat body
  const bubbles = [];
  let lastDateStr = '';

  for (const msg of messages) {
    const isCustomer = msg.role === 'customer';
    const time = fmtTime(msg.created_at);
    const dateStr = fmtDate(msg.created_at);

    // Date divider
    if (dateStr && dateStr !== lastDateStr) {
      lastDateStr = dateStr;
      bubbles.push({
        type: 'div',
        props: {
          style: {
            display: 'flex', justifyContent: 'center',
            padding: '6px 0', margin: '4px 0',
          },
          children: {
            type: 'div',
            props: {
              style: {
                background: '#182229',
                color: '#8696a0',
                fontSize: '11px',
                padding: '4px 12px',
                borderRadius: '6px',
              },
              children: dateStr,
            },
          },
        },
      });
    }

    const text = (msg.isi || '').slice(0, 400);

    // Build bubble content
    const bubbleChildren = [];

    // Label for bot/cs
    if (!isCustomer) {
      const label = msg.role === 'cs' ? 'CS Adsy' : 'Bot Adsy';
      bubbleChildren.push({
        type: 'div',
        props: {
          style: { fontSize: '11px', fontWeight: '600', color: '#53bdeb', marginBottom: '2px' },
          children: label,
        },
      });
    }

    // Message text
    bubbleChildren.push({
      type: 'div',
      props: {
        style: { fontSize: '13px', lineHeight: '1.45', whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: '#e9edef' },
        children: text,
      },
    });

    // Time + checkmark row
    const timeChildren = [time];
    if (!isCustomer) timeChildren.push(' ✓✓');

    bubbleChildren.push({
      type: 'div',
      props: {
        style: {
          display: 'flex', justifyContent: 'flex-end', alignItems: 'center',
          gap: '2px', marginTop: '2px',
        },
        children: {
          type: 'span',
          props: {
            style: { fontSize: '10px', color: isCustomer ? '#8696a0' : '#53bdeb' },
            children: timeChildren.join(''),
          },
        },
      },
    });

    // Bubble wrapper
    bubbles.push({
      type: 'div',
      props: {
        style: {
          display: 'flex',
          justifyContent: isCustomer ? 'flex-start' : 'flex-end',
          padding: '1px 0',
        },
        children: {
          type: 'div',
          props: {
            style: {
              display: 'flex',
              flexDirection: 'column',
              maxWidth: `${BUBBLE_MAX}px`,
              padding: '6px 8px',
              borderRadius: isCustomer ? '0px 8px 8px 8px' : '8px 0px 8px 8px',
              background: isCustomer ? '#202C33' : '#005C4B',
              marginLeft: isCustomer ? '0' : '40px',
              marginRight: isCustomer ? '40px' : '0',
            },
            children: bubbleChildren,
          },
        },
      },
    });
  }

  // Chat area with dark wallpaper
  elements.push({
    type: 'div',
    props: {
      style: {
        display: 'flex',
        flexDirection: 'column',
        padding: `${PAD}px`,
        gap: '3px',
        background: '#0B141A',
        flexGrow: '1',
        minHeight: '200px',
      },
      children: bubbles,
    },
  });

  // Bottom bar — input area hint
  elements.push({
    type: 'div',
    props: {
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '8px 10px',
        background: '#1F2C34',
      },
      children: [
        { type: 'div', props: { style: { fontSize: '16px' }, children: '😊' } },
        {
          type: 'div',
          props: {
            style: {
              flexGrow: '1', background: '#2A3942', borderRadius: '20px',
              padding: '8px 14px', fontSize: '13px', color: '#8696a0',
            },
            children: 'Ketik pesan',
          },
        },
        { type: 'div', props: { style: { fontSize: '16px' }, children: '🎤' } },
      ],
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
        overflow: 'hidden',
        background: '#0B141A',
      },
      children: elements,
    },
  };

  // Height estimation — taller portrait format
  const msgHeights = messages.map(m => {
    const textLen = (m.isi || '').length;
    const lines = Math.ceil(textLen / 32) + (m.isi || '').split('\n').length - 1;
    return Math.max(50, lines * 20 + 36);
  });
  // Add date divider heights
  let dateDividers = 0;
  let prevDate = '';
  for (const m of messages) {
    const d = fmtDate(m.created_at);
    if (d && d !== prevDate) { dateDividers++; prevDate = d; }
  }
  const bodyHeight = msgHeights.reduce((a, b) => a + b, 0) + dateDividers * 34;
  const estimatedHeight = 54 + bodyHeight + PAD * 2 + 50; // header + body + bottom bar

  const svg = await _satori(root, {
    width: WIDTH,
    height: Math.min(Math.max(estimatedHeight, 300), 1600),
    fonts: [{ name: 'Inter', data: _fontData, weight: 400, style: 'normal' }],
  });

  const resvg = new _Resvg(svg, {
    fitTo: { mode: 'width', value: WIDTH * 2 },
  });
  const pngData = resvg.render();
  return pngData.asPng();
}

module.exports = { generateChatImage };
