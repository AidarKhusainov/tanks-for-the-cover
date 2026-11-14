# Тёплый обжитой город

Откройте [tanks-warm-town.html](tanks-warm-town.html) в браузере. Файл можно переносить отдельно и запускать через `file://`. WASD — движение, мышь — прицел, ЛКМ — огонь, Enter — следующая волна, Esc — пауза. Прогноз маршрутов выключен при запуске и доступен под полем.

Из каталога `experiments/warm-town-2d` с Node.js 20 или новее:

```sh
node warm-city-src/build.cjs --blockout
node warm-city-src/check.cjs evidence/warm-town/blockout.html
node warm-city-src/build.cjs
node warm-city-src/check.cjs tanks-warm-town.html
node warm-city-src/browser.cjs tanks-warm-town.html /tmp/warm-town-browser-1366
TANKS_CITY_WIDTH=1280 TANKS_CITY_HEIGHT=720 TANKS_CITY_LAYOUT_ONLY=1 \
  node warm-city-src/browser.cjs tanks-warm-town.html /tmp/warm-town-browser-1280
```

`map.cjs` считывает контуры и двери из `art-directions/layout-approved.html`. Контуры разбиваются на прямоугольники для коллизий и остаются цельными для отрисовки. `renderer.js` собирает поверхности кварталов в Canvas из `art/materials.webp`. `base.js` и `vehicles.js` рисуют базу, танки и корпуса из состояния игры. `build.cjs` встраивает оформление и карту в копию Twin Gates. Для проверки в Chrome требуется новый каталог вывода. Сценарий использует планировщик бота из `tools/verify-campaign.cjs` в корне репозитория.

Атлас уже сохранён рядом с исходниками. Для его повторного извлечения из `art-directions/warm-town.png` выполните `python3 warm-city-src/art/build-atlas.py` с Pillow.

Сборка и геометрия проверяются также через `npm test` из корня репозитория. Вариант фиксирует проверенную версию Twin Gates как исходный HTML для воспроизводимой сборки. Игра из корневого `index.html` развивается отдельно.
