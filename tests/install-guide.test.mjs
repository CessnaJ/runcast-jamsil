import test from 'node:test';
import assert from 'node:assert/strict';
import { detectInstallEnvironment, createInstallController } from '../assets/install-guide.mjs';

function installFixture({ standalone = false } = {}) {
  const target = new EventTarget(), states = [];
  const controller = createInstallController({eventTarget:target,isStandalone:()=>standalone,onChange:state=>states.push(state)});
  return {target,controller,states,setStandalone:value=>{standalone=value;controller.refresh();}};
}

function offerInstall(target, prompt, userChoice) {
  const event = new Event('beforeinstallprompt', {cancelable:true});
  event.prompt = prompt;
  if (userChoice) event.userChoice = userChoice;
  target.dispatchEvent(event);
  return event;
}

test('설치 이벤트가 없으면 안내를 유지하고 지원 이벤트가 오면 클릭할 때만 설치창을 연다', async () => {
  const {target,controller} = installFixture();
  assert.deepEqual(controller.getState(), {visible:true,canPrompt:false,busy:false});
  assert.equal((await controller.prompt()).status, 'unavailable');
  let calls = 0;
  const event = offerInstall(target, () => {calls++;return Promise.resolve({outcome:'dismissed'});});
  assert.equal(event.defaultPrevented, true);
  assert.equal(controller.getState().canPrompt, true);
  assert.equal(calls, 0);
  const request = controller.prompt();
  assert.equal(calls, 1); // Preserve the user's click, without waiting first.
  assert.equal(controller.getState().busy, true);
  assert.equal((await controller.prompt()).status, 'busy');
  assert.equal((await request).status, 'dismissed');
  assert.deepEqual(controller.getState(), {visible:true,canPrompt:false,busy:false});
  assert.equal((await controller.prompt()).status, 'unavailable');
  assert.equal(calls, 1);
  offerInstall(target, async () => ({outcome:'dismissed'}));
  assert.equal(controller.getState().canPrompt, true);
});

test('설치 승인과 설치 완료를 구별하며 완료 후 늦은 이벤트로 메뉴를 다시 표시하지 않는다', async () => {
  const {target,controller} = installFixture();
  offerInstall(target, async () => {}, Promise.resolve({outcome:'accepted'}));
  assert.equal((await controller.prompt()).status, 'accepted');
  assert.equal(controller.getState().visible, true);
  target.dispatchEvent(new Event('appinstalled'));
  assert.equal(controller.getState().visible, false);
  const late = offerInstall(target, async () => ({outcome:'dismissed'}));
  assert.equal(late.defaultPrevented, false);
  assert.equal(controller.getState().canPrompt, false);
});

test('설치창 호출 실패는 안내로 전환할 수 있고 같은 이벤트는 재사용하지 않는다', async () => {
  const {target,controller} = installFixture();
  let calls = 0;
  offerInstall(target, () => {calls++;throw Error('prompt unavailable');});
  assert.equal((await controller.prompt()).status, 'failed');
  assert.deepEqual(controller.getState(), {visible:true,canPrompt:false,busy:false});
  assert.equal((await controller.prompt()).status, 'unavailable');
  assert.equal(calls, 1);
});

test('홈 화면 앱에서는 설치 메뉴를 숨기며 실행 모드가 바뀌면 다시 동기화한다', () => {
  const {target,controller,setStandalone} = installFixture({standalone:true});
  assert.equal(controller.getState().visible, false);
  const event = offerInstall(target, async () => ({outcome:'accepted'}));
  assert.equal(event.defaultPrevented, false);
  setStandalone(false);
  target.dispatchEvent(new Event('pageshow'));
  assert.deepEqual(controller.getState(), {visible:true,canPrompt:false,busy:false});
  offerInstall(target, async () => ({outcome:'accepted'}));
  setStandalone(true);
  assert.deepEqual(controller.getState(), {visible:false,canPrompt:false,busy:false});
});

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
