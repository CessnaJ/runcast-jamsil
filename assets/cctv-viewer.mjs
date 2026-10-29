import { validCctvUrl } from './cctv-domain.mjs';
import { icon } from './ui-icons.mjs';

// Images stay on the user's ITS connection; no server proxy or image cache.
export function bindCctvViewer(container, getCameras, { openDialog = dialog => dialog.showModal() } = {}) {
  let dialog, frame, status, retry, original, title, image, timer, camera, returnTo;
  let generation = 0, previousOverflow = '';
  function stopLoading() {
    ++generation;
    clearTimeout(timer);
    if (image) {
      image.onload = image.onerror = null;
      image.removeAttribute('src');
      image.remove();
      image = null;
    }
  }
  function ensureDialog() {
    if (dialog) return;
    dialog = document.createElement('dialog');
    dialog.id = 'cctvViewer';
    dialog.className = 'cctv-viewer';
    dialog.setAttribute('aria-labelledby', 'cctvViewerTitle');
    dialog.innerHTML = `<header class="cctv-viewer-head"><h2 id="cctvViewerTitle"></h2><button type="button" class="cctv-viewer-close" aria-label="CCTV 닫기" autofocus>${icon('close')}</button></header>
      <div class="cctv-viewer-stage"><div class="cctv-viewer-frame"></div><p class="cctv-viewer-status" role="status" aria-live="polite"></p></div>
      <footer class="cctv-viewer-actions"><span>ITS 제공</span><button type="button" class="cctv-viewer-retry" hidden>다시 시도</button><a class="cctv-viewer-original" target="_blank" rel="noopener noreferrer" hidden>원본 열기 ${icon('external')}</a></footer>`;
    document.body.append(dialog);
    frame = dialog.querySelector('.cctv-viewer-frame');
    status = dialog.querySelector('.cctv-viewer-status');
    retry = dialog.querySelector('.cctv-viewer-retry');
    original = dialog.querySelector('.cctv-viewer-original');
    title = dialog.querySelector('h2');
    dialog.querySelector('.cctv-viewer-close').onclick = () => dialog.close();
    retry.onclick = loadImage;
    dialog.addEventListener('close', () => {
      stopLoading();
      document.documentElement.style.overflow = previousOverflow;
      returnTo?.isConnected && returnTo.focus({ preventScroll: true });
    });
  }
  function loadImage() {
    stopLoading();
    const current = generation;
    status.hidden = false;
    status.textContent = 'CCTV 이미지를 불러오고 있어요';
    retry.hidden = original.hidden = true;
    frame.setAttribute('aria-busy', 'true');
    const picture = new Image();
    image = picture;
    picture.alt = `${camera.name || '주변 CCTV'} 현장 이미지`;
    picture.hidden = true;
    picture.referrerPolicy = 'no-referrer';
    const fail = () => {
      if (current !== generation) return;
      stopLoading();
      frame.setAttribute('aria-busy', 'false');
      status.textContent = '이미지를 불러오지 못했어요';
      retry.hidden = original.hidden = false;
    };
    picture.onload = () => {
      if (current !== generation) return;
      if (!picture.naturalWidth) { fail(); return; }
      clearTimeout(timer);
      picture.hidden = false;
      status.hidden = true;
      frame.setAttribute('aria-busy', 'false');
    };
    picture.onerror = fail;
    frame.replaceChildren(picture);
    timer = setTimeout(fail, 15_000);
    picture.src = camera.url;
  }
  async function open(nextCamera, trigger = document.activeElement) {
    if (!validCctvUrl(nextCamera?.url)) return;
    ensureDialog();
    camera = nextCamera;
    returnTo = trigger;
    title.textContent = camera.name || '주변 CCTV';
    original.href = camera.url;
    if (!dialog.open) {
      previousOverflow = document.documentElement.style.overflow;
      await openDialog(dialog);
      if (!dialog.open) return;
      document.documentElement.style.overflow = 'hidden';
    }
    loadImage();
  }
  container.addEventListener('click', event => {
    const link = event.target.closest('.cctv-card[data-cctv-id]');
    if (!link || !container.contains(link) || event.defaultPrevented || event.button !== 0
      || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const selected = getCameras().find(item => String(item.id) === link.dataset.cctvId);
    if (!selected || !validCctvUrl(selected.url)) return;
    event.preventDefault();
    void open(selected, link);
  });
  return { open, close: () => dialog?.open && dialog.close() };
}
