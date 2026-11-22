// Unit tests for link previews: metadata/price parsing and the private-address guard.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let parseMeta, isPrivateIp;
before(async () => {
  // preview.js reads config at import time.
  process.env.ADMIN_PASSWORD ||= 'test-password-123';
  process.env.DATA_DIR = await mkdtemp(join(tmpdir(), 'giftly-unit-'));
  process.env.APP_LANG = 'pt';
  ({ parseMeta, isPrivateIp } = await import('../src/preview.js'));
});

test('Open Graph image, title and product price', () => {
  const html = `<html><head>
    <meta property="og:title" content="Caneca &amp; Pires">
    <meta property="og:image" content="/img/caneca.jpg">
    <meta property="product:price:amount" content="12.5">
    <meta property="product:price:currency" content="EUR">
  </head></html>`;
  const m = parseMeta(html, 'https://shop.example/p/1');
  assert.equal(m.title, 'Caneca & Pires');
  assert.equal(m.image, 'https://shop.example/img/caneca.jpg');
  assert.equal(m.price, '12,50 €');
});

test('JSON-LD Product with offers', () => {
  const html = `<script type="application/ld+json">
    {"@context":"https://schema.org","@graph":[{"@type":"WebPage"},
     {"@type":"Product","name":"Lamp","image":["https://cdn.example/lamp.png"],
      "offers":{"@type":"Offer","price":"39.90","priceCurrency":"EUR"}}]}
  </script>`;
  const m = parseMeta(html, 'https://shop.example/');
  assert.equal(m.title, 'Lamp');
  assert.equal(m.image, 'https://cdn.example/lamp.png');
  assert.equal(m.price, '39,90 €');
});

test('Amazon pages: landing image (resized) and priceAmount', () => {
  const html = `<title>Tapete : Amazon.es</title>
    <img id="landingImage" data-old-hires="https://m.media-amazon.com/images/I/81abc._AC_SL1500_.jpg" src="x.jpg">
    <script>var d = {"priceAmount":15.20,"currencySymbol":"€"};</script>`;
  const m = parseMeta(html, 'https://www.amazon.es/dp/X');
  assert.equal(m.image, 'https://m.media-amazon.com/images/I/81abc._AC_SL500_.jpg');
  assert.equal(m.price, '15,20 €');
  assert.equal(m.title, 'Tapete : Amazon.es');
});

test('schema.org microdata image and price', () => {
  const html = `<div itemscope itemtype="https://schema.org/Product">
    <img itemprop="image" src="https://cdn.example/p.webp">
    <meta itemprop="price" content="7.99"><meta itemprop="priceCurrency" content="GBP"></div>`;
  const m = parseMeta(html, 'https://shop.example/');
  assert.equal(m.image, 'https://cdn.example/p.webp');
  assert.match(m.price, /7,99/);
  assert.match(m.price, /£/);
});

test('nonsense prices are ignored', () => {
  const html = '<meta property="product:price:amount" content="call us"><meta property="og:title" content="X">';
  assert.equal(parseMeta(html, 'https://shop.example/').price, undefined);
});

test('private, loopback and link-local addresses are refused', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.1.177', '172.16.0.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']) {
    assert.equal(isPrivateIp(ip), true, ip);
  }
  for (const ip of ['1.1.1.1', '8.8.8.8', '172.32.0.1', '2606:4700::1111']) {
    assert.equal(isPrivateIp(ip), false, ip);
  }
});
