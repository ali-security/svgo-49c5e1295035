'use strict';

const { readFile } = require('fs').promises;
const path = require('path');
const { optimize } = require('../../lib/svgo.js');

const DEPTH_ERROR = 'Parsed entity depth exceeds max entity depth';
const COUNT_ERROR = 'Parsed entity count exceeds max entity count';

const entity = (name, value) => `<!ENTITY ${name} "${value}">`;

const createSvg = (declarations, content) =>
  `<!DOCTYPE svg [\n${declarations}\n]>\n<svg>${content}</svg>`;

describe('svgo', () => {
  it('should throw on excessive expansion depth', async () => {
    const original = await readFile(
      path.join(__dirname, 'billion-laughs.svg'),
      'utf-8'
    );
    const result = optimize(original);
    expect(result.error).toMatch(DEPTH_ERROR);
  });

  it('should throw on excessive expansion count', async () => {
    const original = await readFile(
      path.join(__dirname, 'billion-laughs-flat.svg'),
      'utf-8'
    );
    const result = optimize(original);
    expect(result.error).toMatch(COUNT_ERROR);
  });

  it('should throw on recursive entities', () => {
    const direct = createSvg(entity('a', 'lol&a;'), '&a;');
    expect(optimize(direct).error).toMatch(DEPTH_ERROR);
    const mutual = createSvg(entity('a', '&b;') + entity('b', '&a;'), '&a;');
    expect(optimize(mutual).error).toMatch(DEPTH_ERROR);
  });

  it('should count case-insensitive entity references', () => {
    const lol = entity('lol', 'lol');
    const lol1 = entity('lol1', '&LOL;'.repeat(30));
    const lol2 = entity('lol2', '&LOL1;'.repeat(30));
    const svg = createSvg(lol + lol1 + lol2, '&lol2;');
    expect(optimize(svg).error).toMatch(COUNT_ERROR);
  });

  it('should count entity references formed while parsing', () => {
    const lol = entity('lol', 'lol');
    const lol1 = entity('lol1', '&#38;lol;'.repeat(30));
    const lol2 = entity('lol2', '&#38;lol1;'.repeat(30));
    const svg = createSvg(lol + lol1 + lol2, '&lol2;');
    expect(optimize(svg).error).toMatch(COUNT_ERROR);
  });

  it('should count entity references completed by other entities', () => {
    const lol = entity('lol', 'lol') + entity('prefix', '&lo');
    const lol1 = entity('lol1', '&prefix;l;'.repeat(30));
    const lol2 = entity('lol2', '&prefix;l1;'.repeat(30));
    const svg = createSvg(lol + lol1 + lol2, '&lol2;');
    expect(optimize(svg).error).toMatch(COUNT_ERROR);
  });

  it('should count entity expansions across the document', () => {
    const lol = entity('lol', 'lol');
    const allowed = optimize(createSvg(lol, '&lol;'.repeat(512)));
    expect(allowed.error).toBeUndefined();
    const excessive = optimize(createSvg(lol, '&lol;'.repeat(513)));
    expect(excessive.error).toMatch(COUNT_ERROR);
  });
});
