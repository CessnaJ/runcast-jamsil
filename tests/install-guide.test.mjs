import test from 'node:test';
import assert from 'node:assert/strict';
import { detectInstallEnvironment } from '../assets/install-guide.mjs';

test('설치 안내는 기기보다 실제 브라우저를 우선 구분한다', () => {
  const android = 'Mozilla/5.0 (Linux; Android 16; SM-S938N) AppleWebKit/537.36';
  assert.equal(detectInstallEnvironment({userAgent: `${android} Chrome/140.0.0.0 Mobile Safari/537.36`}).guide, 'chrome');
  assert.equal(detectInstallEnvironment({userAgent: `${android} SamsungBrowser/29.0 Chrome/136.0.0.0 Mobile Safari/537.36`}).guide, 'samsung');
  assert.equal(detectInstallEnvironment({userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 Version/26.0 Mobile/15E148 Safari/604.1'}).guide, 'ios-safari');
  assert.equal(detectInstallEnvironment({userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 CriOS/140.0.0.0 Mobile/15E148 Safari/604.1'}).guide, 'ios-chrome');
  assert.equal(detectInstallEnvironment({userAgent: 'Mozilla/5.0 (Macintosh) Version/26.0 Safari/605.1.15',platform:'MacIntel',maxTouchPoints:5}).guide, 'ios-safari');
});

test('앱 내 브라우저와 알 수 없는 환경에 잘못된 설치 단계를 자동 선택하지 않는다', () => {
  const embedded = detectInstallEnvironment({userAgent:'Mozilla/5.0 (Linux; Android 16; SM-S938N; wv) Chrome/140.0.0.0 KAKAOTALK/26.0'});
  assert.equal(embedded.inApp, true);
  assert.equal(embedded.guide, '');
  assert.equal(detectInstallEnvironment({userAgent:'Mozilla/5.0 (Windows NT 10.0) Chrome/140.0.0.0 Safari/537.36'}).guide, '');
  assert.equal(detectInstallEnvironment({userAgent:'Mozilla/5.0 (Linux; Android 16) Chrome/140.0.0.0 EdgA/140.0.0.0'}).guide, '');
  assert.equal(detectInstallEnvironment({standalone:true}).standalone, true);
});
