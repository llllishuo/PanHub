/**
 * 分享链接解析测试
 *
 * 重点不只是「能解析」，还要验证「不能解析的必须诚实报告」——
 * 引擎没有对应分享驱动时，绝不能假装支持。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseShareLink,
  extractUrl,
  extractPassword,
  ShareParseError,
  SHARE_PROVIDERS,
} from '../src/core/share.ts';

test('百度网盘：提取分享 ID 与提取码，但明确标注不支持', () => {
  const r = parseShareLink(
    'https://pan.baidu.com/s/1LUDPV661OOlE_iVd7AsmzA?pwd=1111',
  );
  assert.equal(r.provider, 'baidu');
  assert.equal(r.providerLabel, '百度网盘');
  assert.equal(r.shareId, '1LUDPV661OOlE_iVd7AsmzA');
  assert.equal(r.password, '1111');
  assert.equal(r.driver, null);
  assert.equal(r.supported, false, '引擎没有百度分享驱动，不能声称支持');
  assert.match(r.note, /没有百度网盘的/);
});

test('百度口令文本：从整段复制内容里也能提取', () => {
  const text =
    '通过百度网盘分享的文件：nanoUART-wl.zip\n' +
    '链接: https://pan.baidu.com/s/1LUDPV661OOlE_iVd7AsmzA 提取码: 1111\n' +
    '复制这段内容后打开百度网盘手机App，操作更方便哦';
  const r = parseShareLink(text);
  assert.equal(r.shareId, '1LUDPV661OOlE_iVd7AsmzA');
  assert.equal(r.password, '1111');
});

test('阿里云盘：映射到 AliyundriveShare，并提示还需要 refresh_token', () => {
  const r = parseShareLink('https://www.alipan.com/s/abc123XYZ');
  assert.equal(r.provider, 'aliyun');
  assert.equal(r.driver, 'AliyundriveShare');
  assert.equal(r.supported, true);
  assert.equal(r.addition.share_id, 'abc123XYZ');
  assert.deepEqual(r.missing, ['refresh_token']);
});

test('阿里云盘旧域名 aliyundrive.com 同样识别', () => {
  const r = parseShareLink('https://www.aliyundrive.com/s/xyz789/pwd=abcd');
  assert.equal(r.provider, 'aliyun');
  assert.equal(r.addition.share_id, 'xyz789');
});

test('115：同时映射分享码与接收码字段', () => {
  const r = parseShareLink('https://115.com/s/swabc123?password=x9y8');
  assert.equal(r.provider, '115');
  assert.equal(r.driver, '115 Share');
  assert.equal(r.addition.share_code, 'swabc123');
  assert.equal(r.addition.receive_code, 'x9y8');
  assert.deepEqual(r.missing, []);
});

test('123 云盘：映射 sharekey / sharepassword', () => {
  const r = parseShareLink('https://www.123pan.com/s/abcd-1234?pwd=5678');
  assert.equal(r.provider, '123pan');
  assert.equal(r.driver, '123PanShare');
  assert.equal(r.addition.sharekey, 'abcd-1234');
  assert.equal(r.addition.sharepassword, '5678');
});

test('PikPak：映射 share_id / share_pwd', () => {
  const r = parseShareLink('https://mypikpak.com/s/VOabc123?pwd=k3m9');
  assert.equal(r.provider, 'pikpak');
  assert.equal(r.driver, 'PikPakShare');
  assert.equal(r.addition.share_id, 'VOabc123');
  assert.equal(r.addition.share_pwd, 'k3m9');
});

test('OneDrive：驱动需要完整链接，而不是 ID', () => {
  const url = 'https://1drv.ms/f/s!AbCdEfGhIjKlMn';
  const r = parseShareLink(url);
  assert.equal(r.provider, 'onedrive');
  assert.equal(r.driver, 'Onedrive Sharelink');
  assert.equal(r.addition.url, url, 'Onedrive Sharelink 接收的是完整 URL');
});

test('夸克 / UC / 迅雷 / 蓝奏 / 天翼 / 微云 / TeraBox：识别但不支持', () => {
  const cases: [string, string][] = [
    ['https://pan.quark.cn/s/abc123def', 'quark'],
    ['https://drive.uc.cn/s/abc123def', 'uc'],
    ['https://pan.xunlei.com/s/VNabc123', 'xunlei'],
    ['https://wwx.lanzoux.com/iabc1234', 'lanzou'],
    ['https://cloud.189.cn/t/AbCdEf123', '189'],
    ['https://share.weiyun.com/AbCdEf123456', 'weiyun'],
    ['https://www.terabox.com/s/1abcdEFGhi', 'terabox'],
  ];
  for (const [url, key] of cases) {
    const r = parseShareLink(url);
    assert.equal(r.provider, key, `识别错误：${url}`);
    assert.equal(r.supported, false, `${key} 不该被标为支持`);
    assert.equal(r.driver, null);
    assert.ok(r.note.length > 0, `${key} 应给出说明`);
  }
});

test('不支持的站点必须抛错并列出可识别清单', () => {
  assert.throws(
    () => parseShareLink('https://example.com/s/abc'),
    (e: unknown) => e instanceof ShareParseError && /暂不支持该站点/.test(e.message),
  );
});

test('文本里没有链接时抛错', () => {
  assert.throws(
    () => parseShareLink('这是一段没有链接的文字'),
    (e: unknown) => e instanceof ShareParseError && /没有找到链接/.test(e.message),
  );
});

test('空输入抛错', () => {
  assert.throws(() => parseShareLink('   '), ShareParseError);
});

test('识别到站点但提取不到 ID 时抛错', () => {
  assert.throws(
    () => parseShareLink('https://pan.baidu.com/'),
    (e: unknown) => e instanceof ShareParseError && /无法从链接里提取分享 ID/.test(e.message),
  );
});

test('extractUrl / extractPassword 单独行为', () => {
  assert.equal(
    extractUrl('看这个 https://a.com/x 谢谢'),
    'https://a.com/x',
  );
  assert.equal(extractUrl('没有链接'), null);
  assert.equal(extractPassword('链接 xxx 提取码：ab12'), 'ab12');
  assert.equal(extractPassword('?pwd=zz99'), 'zz99');
  assert.equal(extractPassword('无'), '');
});

test('所有声明支持的提供方都必须有驱动和 ID 字段', () => {
  for (const p of SHARE_PROVIDERS) {
    if (p.driver) {
      assert.ok(p.idField, `${p.key} 声明了驱动却没有 idField`);
    }
    if (p.driver === null) {
      assert.ok(p.note && p.note.length > 0, `${p.key} 不支持时必须给出说明`);
    }
  }
});

test('每个提供方都有可被识别的示例链接（防止正则写错）', () => {
  const samples: Record<string, string> = {
    baidu: 'https://pan.baidu.com/s/1abc',
    aliyun: 'https://www.alipan.com/s/abc',
    quark: 'https://pan.quark.cn/s/abc',
    uc: 'https://drive.uc.cn/s/abc',
    '115': 'https://115.com/s/abc',
    xunlei: 'https://pan.xunlei.com/s/abc',
    '123pan': 'https://www.123pan.com/s/abc',
    lanzou: 'https://wwx.lanzoux.com/iabc1234',
    '189': 'https://cloud.189.cn/t/abc',
    weiyun: 'https://share.weiyun.com/abcdefghij',
    pikpak: 'https://mypikpak.com/s/abc',
    terabox: 'https://www.terabox.com/s/abc',
    onedrive: 'https://1drv.ms/f/s!abc',
  };
  for (const p of SHARE_PROVIDERS) {
    const sample = samples[p.key];
    assert.ok(sample, `缺少 ${p.key} 的示例链接`);
    const r = parseShareLink(sample);
    assert.equal(r.provider, p.key, `${p.key} 示例链接解析到了 ${r.provider}`);
    assert.ok(r.shareId.length > 0 || r.driver === null, `${p.key} 未提取到 ID`);
  }
});
