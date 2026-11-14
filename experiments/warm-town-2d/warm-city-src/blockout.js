  function paintGround(c) {
    c.fillStyle = '#b4afa1';
    c.fillRect(0, 0, CONFIG.W, CONFIG.H);
    const { x, y, w, h } = CONFIG.CITY.plaza;
    c.fillStyle = '#e5d8bd';
    c.fillRect(x, y, w, h);
    c.fillRect(0, 16, CONFIG.W, 2);
  }
  function paintCityCover(c) {
    for (const { shape } of CONFIG.CITY.buildings) {
      c.beginPath();
      shape.forEach(([x, y], i) => i ? c.lineTo(x, y) : c.moveTo(x, y));
      c.closePath();
      c.fillStyle = '#565a53';
      c.fill();
    }
    for (const { p: [[x, y], [u, v]] } of CONFIG.CITY.doors) {
      segment(c, x, y, u, v, '#ffcd83', .075);
    }
  }
