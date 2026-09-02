const fs = require('fs');
let c = fs.readFileSync('renderer.js', 'utf8');
c = c.replace(/&apos;/g, '\'');
fs.writeFileSync('renderer.js', c);
console.log('fixed renderer.js');
