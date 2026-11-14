  function attemptResultGrid(baseHp) {
    return `<div class="result-grid">
      <div><strong>${game.stats.kills}</strong><span>ТАНКОВ УНИЧТОЖЕНО</span></div>
      <div><strong>${game.stats.wrecksCreated}</strong><span>КОРПУСОВ СОЗДАНО</span></div>
      <div><strong>${baseHp}</strong><span>HP БАЗЫ</span></div>
    </div>`;
  }

  function updateWaveCard({ prep, finished, baseHp }) {
    el('wave-note').hidden = finished;
    if (finished) {
      const cleared = game.phase === 'won' ? waveCount : game.waveIndex;
      el('wave-card-title').textContent = 'ИТОГ ПОПЫТКИ';
      el('enemy-total').textContent = `${cleared} из ${waveCount} волн`;
      el('wave-plan').innerHTML = attemptResultGrid(baseHp);
      return;
    }
    const plan = CONFIG.WAVES[game.waveIndex];
    const total = plan.reduce((n, group) => n + group.types.length, 0);
    el('wave-card-title').textContent = prep ? 'СЛЕДУЮЩАЯ АТАКА' : 'АТАКА ЭТОЙ ВОЛНЫ';
    el('enemy-total').textContent = `${total} ${{one:'танк',few:'танка',many:'танков',other:'танка'}[tankPlural.select(total)]}`;
    el('wave-plan').innerHTML = waveGroups(plan);
    el('wave-note').textContent = `Между появлениями на одном входе не менее ${spawnInterval} с.`;
  }
