/**
 * Chat Image Generator — render chat messages jadi PNG (mirip screenshot WA dark mode)
 * Dipakai untuk forward feedback customer bermasalah ke grup ekspedisi
 *
 * Usage: const pngBuffer = await generateChatImage(messages, customerName, customerPhone, resi, ekspedisi)
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

async function generateChatImage(messages, customerName, customerPhone, resi, ekspedisi) {
  await loadDeps();

  const WIDTH = 390;
  const PAD = 10;
  const BUBBLE_MAX = 268;

  const fmtTime = (dt) => {
    if (!dt) return '';
    return new Date(dt).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jakarta' });
  };

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

  const elements = [];

  // ── Header: simple, clean ──
  elements.push({
    type: 'div',
    props: {
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        padding: '10px 14px',
        background: '#1F2C34',
      },
      children: [
        // Back arrow
        { type: 'span', props: { style: { fontSize: '20px', color: '#aebac1' }, children: '\u2039' } },
        // Avatar circle with initial
        {
          type: 'div',
          props: {
            style: {
              width: '38px', height: '38px', borderRadius: '19px',
              background: '#00a884',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: '17px', fontWeight: '700', color: '#fff',
            },
            children: (customerName || '?')[0].toUpperCase(),
          },
        },
        // Name/phone + online
        {
          type: 'div',
          props: {
            style: { display: 'flex', flexDirection: 'column', flexGrow: '1' },
            children: [
              { type: 'div', props: { style: { fontSize: '15px', fontWeight: '600', color: '#e9edef' }, children: customerPhone || customerName || 'Customer' } },
              { type: 'div', props: { style: { fontSize: '11px', color: '#00a884' }, children: 'online' } },
            ],
          },
        },
      ],
    },
  });

  // ── Chat area ──
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
          style: { display: 'flex', justifyContent: 'center', padding: '6px 0', margin: '2px 0' },
          children: {
            type: 'div',
            props: {
              style: {
                background: '#182229',
                color: '#8696a0',
                fontSize: '11px',
                padding: '5px 12px',
                borderRadius: '7px',
              },
              children: dateStr,
            },
          },
        },
      });
    }

    const text = (msg.isi || '').slice(0, 400);
    const bubbleChildren = [];

    // Message text
    bubbleChildren.push({
      type: 'div',
      props: {
        style: {
          fontSize: '13.5px',
          lineHeight: '1.4',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          color: isCustomer ? '#e9edef' : '#e9edef',
        },
        children: text,
      },
    });

    // Time + checkmark
    const timeRow = [];
    timeRow.push({
      type: 'span',
      props: { style: { fontSize: '10px', color: isCustomer ? '#8696a0' : '#8696a0' }, children: time },
    });
    if (!isCustomer) {
      // SVG double checkmark — drawn manually, mirip WA read receipt
      timeRow.push({
        type: 'svg',
        props: {
          width: '16',
          height: '10',
          viewBox: '0 0 16 10',
          style: { marginLeft: '3px' },
          children: [
            // First check (back)
            { type: 'path', props: { d: 'M1.5 5.5 L4.5 8.5 L11 2', fill: 'none', stroke: '#53bdeb', strokeWidth: '1.5', strokeLinecap: 'round', strokeLinejoin: 'round' } },
            // Second check (front, offset right)
            { type: 'path', props: { d: 'M5 5.5 L8 8.5 L14.5 2', fill: 'none', stroke: '#53bdeb', strokeWidth: '1.5', strokeLinecap: 'round', strokeLinejoin: 'round' } },
          ],
        },
      });
    }

    bubbleChildren.push({
      type: 'div',
      props: {
        style: { display: 'flex', justifyContent: 'flex-end', alignItems: 'center', marginTop: '1px' },
        children: timeRow,
      },
    });

    // Bubble
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
              padding: '6px 8px 4px 8px',
              borderRadius: isCustomer ? '0px 8px 8px 8px' : '8px 0px 8px 8px',
              background: isCustomer ? '#202C33' : '#005C4B',
              marginLeft: isCustomer ? '0' : '50px',
              marginRight: isCustomer ? '50px' : '0',
            },
            children: bubbleChildren,
          },
        },
      },
    });
  }

  elements.push({
    type: 'div',
    props: {
      style: {
        display: 'flex',
        flexDirection: 'column',
        padding: `${PAD}px`,
        gap: '2px',
        background: '#0B141A',
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
        overflow: 'hidden',
        background: '#0B141A',
      },
      children: elements,
    },
  };

  // Height estimation
  const msgHeights = messages.map(m => {
    const textLen = (m.isi || '').length;
    const lines = Math.ceil(textLen / 30) + (m.isi || '').split('\n').length - 1;
    return Math.max(46, lines * 19 + 30);
  });
  let dateDividers = 0;
  let prevDate = '';
  for (const m of messages) {
    const d = fmtDate(m.created_at);
    if (d && d !== prevDate) { dateDividers++; prevDate = d; }
  }
  const bodyHeight = msgHeights.reduce((a, b) => a + b, 0) + dateDividers * 30;
  const estimatedHeight = 58 + bodyHeight + PAD * 2;

  const svg = await _satori(root, {
    width: WIDTH,
    height: Math.min(Math.max(estimatedHeight, 250), 1600),
    fonts: [{ name: 'Inter', data: _fontData, weight: 400, style: 'normal' }],
  });

  const resvg = new _Resvg(svg, {
    fitTo: { mode: 'width', value: WIDTH },
  });
  const pngData = resvg.render();
  return pngData.asPng();
}

module.exports = { generateChatImage };
