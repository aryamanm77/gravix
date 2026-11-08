const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const gravixLogo = path.join(root, 'media', 'gravix-logo.png');
const target = path.join(root, 'media', 'icon.png');
if (fs.existsSync(gravixLogo)) {
  fs.copyFileSync(gravixLogo, target);
} else {
  const { Resvg } = require('@resvg/resvg-js');
  const svg = fs.readFileSync(path.join(__dirname, 'icon.svg'));
  fs.writeFileSync(target, new Resvg(svg).render().asPng());
}

