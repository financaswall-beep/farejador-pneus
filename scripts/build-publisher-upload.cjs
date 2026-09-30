'use strict';

const { readFileSync } = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');

const root = path.resolve(__dirname, '..');
const license = readFileSync(path.join(root, 'node_modules/tus-js-client/LICENSE'), 'utf8');

// Bundle local e versionado: nenhum script de CDN executa no painel autenticado.
esbuild.buildSync({
  stdin: {
    contents: "export { Upload } from 'tus-js-client';",
    resolveDir: root,
    sourcefile: 'publisher-upload-client.js',
  },
  outfile: path.join(root, 'painel/public/vendor/publisher-tus-4.3.1.min.js'),
  bundle: true,
  platform: 'browser',
  format: 'iife',
  globalName: 'PublisherTus',
  target: ['es2020'],
  minify: true,
  legalComments: 'inline',
  banner: { js: `/* tus-js-client 4.3.1\n${license.replace(/\*\//g, '* /')}*/` },
});
