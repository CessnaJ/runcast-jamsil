// Use the browser's install event when available; keep instructions as a fallback.
export function createInstallController({ eventTarget, isStandalone, onChange }) {
  let deferredPrompt = null, busy = false, installed = false;
  const getState = () => {
    const visible = !installed && !isStandalone();
    return { visible, canPrompt: visible && !!deferredPrompt && !busy, busy };
  };
  const refresh = () => onChange(getState());
  eventTarget.addEventListener('beforeinstallprompt', event => {
    if (!getState().visible || typeof event.prompt !== 'function') return;
    event.preventDefault();
    deferredPrompt = event;
    refresh();
  });
  eventTarget.addEventListener('appinstalled', () => {
    installed = true;
    deferredPrompt = null;
    refresh();
  });
  eventTarget.addEventListener('pageshow', refresh);
  refresh();
  return {
    getState, refresh,
    async prompt() {
      if (busy) return { status: 'busy' };
      if (!getState().canPrompt) return { status: 'unavailable' };
      const event = deferredPrompt;
      deferredPrompt = null; // Each browser event can only be used once.
      busy = true;
      refresh();
      try {
        // Call before the first await so the menu click retains user activation.
        const result = await event.prompt();
        const choice = event.userChoice ? await event.userChoice : result;
        return { status: choice?.outcome === 'accepted' ? 'accepted' : 'dismissed' };
      } catch {
        return { status: 'failed' };
      } finally {
        busy = false;
        refresh();
      }
    },
  };
}

export function detectInstallEnvironment({ userAgent = '', platform = '', maxTouchPoints = 0, standalone = false } = {}) {
  const ios = /iPhone|iPad|iPod/i.test(userAgent) || (platform === 'MacIntel' && maxTouchPoints > 1);
  const inApp = /KAKAOTALK|Instagram|FBAN|FBAV|NAVER\(|Line\/|; wv\)/i.test(userAgent);
  let guide = '';
  if (/Android/i.test(userAgent)) {
    if (/SamsungBrowser\//i.test(userAgent)) guide = 'samsung';
    else if (/Chrome\//i.test(userAgent) && !/EdgA|OPR\//i.test(userAgent)) guide = 'chrome';
  } else if (ios) {
    if (/CriOS\//i.test(userAgent)) guide = 'ios-chrome';
    else if (/Version\/.*Safari\//i.test(userAgent)) guide = 'ios-safari';
  }
  return { guide: inApp ? '' : guide, inApp, standalone };
}

const guides = {
  'chrome': {
    steps: ['Chrome 주소창 옆 <strong>⋮</strong>를 눌러주세요.', '<strong>설치 및 바로가기 만들기 → 설치</strong>를 선택해 주세요.', '화면의 안내에 따라 설치해 주세요.'],
    helpTitle: '메뉴 이름이 다른가요?',
    help: '버전에 따라 앱 설치 또는 홈 화면에 추가로 표시될 수 있어요.',
  },
  samsung: {
    steps: ['삼성 인터넷의 <strong>메뉴 ☰</strong>를 눌러주세요.', '<strong>현재 페이지 추가 → 홈 화면</strong>을 선택해 주세요.', '<strong>추가</strong>를 눌러주세요. 확인창이 한 번 더 나오면 추가를 다시 눌러주세요.'],
  },
  'ios-safari': {
    steps: ['Safari의 <strong>공유 버튼</strong>(위로 향한 화살표)을 눌러주세요.<small>안 보이면 주소창 옆 더 보기 → 공유를 선택해 주세요.</small>', '목록을 내려 <strong>홈 화면에 추가</strong>를 눌러주세요.', '<strong>웹 앱으로 열기</strong>가 보이면 켜고, <strong>추가</strong>를 눌러주세요.'],
    helpTitle: '홈 화면에 추가가 없나요?',
    help: '공유 목록 맨 아래 동작 편집에서 홈 화면에 추가를 찾아주세요.',
  },
  'ios-chrome': {
    steps: ['Chrome 주소창 옆 <strong>공유 버튼</strong>을 눌러주세요.', '<strong>홈 화면에 추가</strong>를 선택해 주세요.', '이름을 확인하고 <strong>추가</strong>를 눌러주세요.'],
    helpTitle: '홈 화면에 추가가 없나요?',
    help: '아래에서 주소를 복사해 Safari로 열어주세요.',
    copy: true,
  },
};

export function createInstallGuide({ openSheet }) {
  const dialog = document.querySelector('#installSheet');
  const select = document.querySelector('#installBrowser');
  const content = document.querySelector('#installInstructions');
  const notice = document.querySelector('#installNotice');
  const copyArea = document.querySelector('#installCopy');
  const address = document.querySelector('#installAddress');
  const copyButton = document.querySelector('#copyInstallUrl');
  const copyStatus = document.querySelector('#installCopyStatus');
  // Always share the public app, including when this guide is tested locally.
  const publicUrl = 'https://runcast-jamsil.vercel.app/mobile.html';
  address.value = publicUrl;
  let environment;

  function render() {
    copyStatus.textContent = '';
    const guide = guides[select.value];
    const installed = environment.standalone;
    select.parentElement.hidden = installed;
    notice.hidden = !installed && !environment.inApp;
    notice.textContent = installed ? '홈 화면 앱으로 사용 중이에요.' : environment.inApp ? 'Chrome이나 Safari에서 열어주세요. 주소를 복사한 뒤 브라우저 주소창에 붙여넣으면 돼요.' : '';
    content.innerHTML = installed ? '' : guide ? `<ol class="install-steps">${guide.steps.map(step => `<li>${step}</li>`).join('')}</ol><p class="install-finish">홈 화면의 <strong>RunCast 아이콘</strong>으로 열어주세요.</p>${guide.help ? `<details class="install-help"><summary>${guide.helpTitle}</summary><p>${guide.help}</p></details>` : ''}` : '<p class="install-empty">설치할 브라우저를 선택하면 방법을 안내해 드려요.</p>';
    copyArea.hidden = installed || !(environment.inApp || guide?.copy || !guide);
  }

  select.addEventListener('change', render);
  copyButton.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(publicUrl);
      copyStatus.textContent = 'RunCast 주소를 복사했어요.';
    } catch {
      address.focus(); address.select();
      copyStatus.textContent = '주소를 길게 눌러 복사해 주세요.';
    }
  });
  address.addEventListener('click', () => address.select());

  return function openInstallGuide() {
    environment = detectInstallEnvironment({
      userAgent: navigator.userAgent, platform: navigator.platform, maxTouchPoints: navigator.maxTouchPoints,
      standalone: window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true,
    });
    select.value = environment.guide;
    render();
    return openSheet(dialog);
  };
}
