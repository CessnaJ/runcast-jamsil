import { WEAR_BANDS, WEAR_POLICY } from './weather-domain.mjs';

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const degrees = value => String(value).replace('-', '−');

export function renderWearReference({ recommendation = null, bottomFit = 'pants' } = {}) {
  let lower = WEAR_POLICY.minimumTemperature;
  const rows = WEAR_BANDS.map(band => {
    const from = lower;
    lower = band.below;
    const selected = recommendation?.status === 'recommended'
      && recommendation.adjusted >= from && recommendation.adjusted < band.below;
    const label = Number.isFinite(band.below)
      ? `${degrees(from)}~${degrees(band.below)}°`
      : `${degrees(from)}° 이상`;
    const bottom = bottomFit === 'tights' && band.tights ? band.tights : band.bottom;
    const cells = [band.outer, band.top, bottom, band.socks, band.accessories]
      .map(item => `<td>${item ? esc(item) : '<span class="wear-reference-none">없음</span>'}</td>`).join('');
    return `<tr${selected ? ' class="selected-wear-band" aria-current="true"' : ''}><th scope="row">${esc(label)}${selected ? '<span class="wear-reference-selected">선택 시간</span>' : ''}</th>${cells}</tr>`;
  }).join('');
  return `<table class="wear-reference-table"><caption class="sr-only">체감온도별 가벼운 1시간 러닝의 기본 옷차림. 각 구간은 시작 온도 이상, 끝 온도 미만이에요.</caption><colgroup><col class="wear-reference-temperature"><col class="wear-reference-outer"><col class="wear-reference-top"><col class="wear-reference-bottom"><col class="wear-reference-socks"><col class="wear-reference-accessories"></colgroup><thead><tr>${['체감 °C','겉옷','상의','하의','양말','보조'].map(label => `<th scope="col">${label}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>`;
}
