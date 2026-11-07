import { hourlyPointAt, runSampleMetrics, evaluateRunWindow } from './weather-domain.mjs';

const esc = (value = '') => String(value).replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]));
const number = (value, unit = '') => Number.isFinite(value) ? `${value}${unit}` : '—';
const validDate = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const dateParts = value => new Intl.DateTimeFormat('en-GB', {
  timeZone:'Asia/Seoul', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hourCycle:'h23',
}).formatToParts(new Date(value)).reduce((parts, part) => ({ ...parts, [part.type]:part.value }), {});
function stamp(value, withDate = true) {
  if (!validDate(value)) return '—';
  const p = dateParts(value);
  return `${withDate ? `${p.month}/${p.day} ` : ''}${p.hour}:${p.minute}`;
}
function amount(value, text) {
  // Missing provider amounts must never inherit the legacy "0 mm" placeholder.
  return Number.isFinite(value) ? (typeof text === 'string' && text.trim() ? text : `${value}mm`) : '—';
}
// KMA PTY categories: https://data.kma.go.kr/data/rmt/rmtList.do?code=410&pgmNo=571
function precipitationType(value) {
  const names = { 0:'없음', 1:'비', 2:'비·눈', 3:'눈', 4:'소나기', 5:'빗방울', 6:'빗방울·눈날림', 7:'눈날림' };
  return Number.isFinite(value) ? names[value] || `코드 ${value}` : '—';
}
const sourceMeta = sample => ({ issuedAt:sample?.issuedAt, fetchedAt:sample?.sourceFetchedAt, stale:sample?.sourceStale });
const villageMeta = sample => sample?.source === 'village' ? { ...sourceMeta(sample), sourceTime:sample.sourceTime } : sample?.probabilityMeta;
const supported = sample => sample && !sample.unavailable && sample.source !== 'demo' && sample.source !== 'unavailable' && !sample.staleForTarget;

function metadata(entries, { issued = true } = {}) {
  const groups = new Map();
  for (const { label, meta } of entries) {
    const text = [
      issued ? `발표 ${validDate(meta?.issuedAt) ? stamp(meta.issuedAt) : '시각 자료 없음'}` : null,
      `수신 ${validDate(meta?.fetchedAt) ? stamp(meta.fetchedAt) : '시각 자료 없음'}`,
      meta?.stale ? '갱신 지연 · 마지막으로 받은 자료' : null,
    ].filter(Boolean).join(' · ');
    if (!groups.has(text)) groups.set(text, []);
    groups.get(text).push(label);
  }
  return [...groups].map(([text, labels]) => `<p class="forecast-meta">${groups.size > 1 ? `${esc(labels.join('·'))}: ` : ''}${esc(text)}</p>`).join('');
}

function table(title, phases, rows, { note = '', meta = '', url = '' } = {}) {
  const heading = url ? `<a href="${url}" target="_blank" rel="noopener noreferrer">${esc(title)}</a>` : esc(title);
  return `<section class="forecast-source"><h3>${heading}</h3>${note ? `<p class="forecast-meta">${esc(note)}</p>` : ''}
    <table class="forecast-source-table"><caption class="sr-only">${esc(title)} · 출발부터 복귀까지의 원자료</caption>
      <thead><tr><th scope="col">항목</th>${phases.map(phase => `<th scope="col">${esc(phase.label)}<small>${esc(stamp(phase.at, false))}</small></th>`).join('')}</tr></thead>
      <tbody>${rows.map(row => `<tr><th scope="row">${esc(row.label)}</th>${row.cells.map(cell => `<td>${cell}</td>`).join('')}</tr>`).join('')}</tbody>
    </table>${meta}</section>`;
}

/** Readable provider values, kept separate from RunCast's derived estimates. */
export function renderForecastDetails({ mode, thermal, recent, cached = false } = {}) {
  const phases = ['출발', '30분 후', '복귀'].map((label, index) => {
    const phase = index === 1 ? '30분' : label;
    const sample = mode?.samples?.find(item => item.phase === phase) || null;
    return { label, at:sample?.at || (index === 0 ? mode?.departureAt : index === 2 ? mode?.endAt : null), sample };
  });
  const official = phases.map(({ sample }) => sample && ['ultra','village'].includes(sample.source)
    && validDate(sample.sourceTime) && !sample.staleForTarget ? sample : null);
  const village = official.map(sample => {
    if (!sample) return null;
    return {
      probability:sample.probability,
      precipitationType:sample.source === 'village' ? sample.precipitationType : sample.villagePrecipitationType,
      mm:sample.source === 'village' ? sample.mm : sample.villageMm,
      amountText:sample.source === 'village' ? sample.amountText : sample.probabilityAmountText,
      meta:villageMeta(sample),
    };
  });
  const rawRow = (label, values) => ({ label, cells:values.map(esc) });
  const villageTable = table('눈·비: 기상청 단기예보', phases, [
    rawRow('강수확률', village.map(item => number(item?.probability, '%'))),
    rawRow('1시간 강수량', village.map(item => amount(item?.mm, item?.amountText))),
    rawRow('강수형태', village.map(item => precipitationType(item?.precipitationType))),
    rawRow('예보 대상', village.map(item => stamp(item?.meta?.sourceTime))),
  ], { url:'https://apihub.kma.go.kr/apiList.do?seqApi=10',
    meta:metadata(phases.map((phase, index) => ({ label:phase.label, meta:village[index]?.meta }))) });

  const ultra = official.map(sample => sample?.source === 'ultra' ? sample : null);
  const ultraTable = ultra.some(Boolean) ? table('눈·비: 기상청 초단기예보', phases, [
    rawRow('1시간 강수량', ultra.map(item => amount(item?.mm, item?.amountText))),
    rawRow('강수형태', ultra.map(item => precipitationType(item?.precipitationType))),
    rawRow('예보 대상', ultra.map(item => stamp(item?.sourceTime))),
  ], { note:'앱의 강수확률은 단기예보 값을 사용해요.',
    url:'https://apihub.kma.go.kr/apiList.do?seqApi=10',
    meta:metadata(phases.map((phase, index) => ({ label:phase.label, meta:sourceMeta(ultra[index]) }))) }) : '';

  const hourly = phases.map(phase => hourlyPointAt(thermal?.data?.hourly, phase.at));
  const thermalTable = table('기온·바람: Open-Meteo', phases, [
    ...[['기온','temperature','°C'], ['체감온도','feelsLike','°C'], ['바람','windSpeed','m/s'], ['돌풍','gusts','m/s'], ['습도','humidity','%']]
      .map(([label, field, unit]) => rawRow(label, hourly.map(item => number(item?.[field], unit)))),
    rawRow('예보 대상', hourly.map(item => stamp(item?.time))),
  ], { url:'https://open-meteo.com/en/docs',
    note:thermal?.status === 'loading' && !thermal?.data ? '기온 자료를 불러오는 중이에요.' : '선택한 시각이 속한 정시의 시간별 예보예요.',
    meta:metadata([{ label:'', meta:{ fetchedAt:thermal?.data?.fetchedAt, stale:thermal?.data?.refresh?.stale || thermal?.data?.cache?.stale } }], { issued:false }) });

  const modelIds = new Map();
  for (const { sample } of phases) for (const model of sample?.multiModel?.models || []) {
    if (model && (model.id || model.label)) modelIds.set(model.id || model.label, model.label || model.id);
  }
  const modelRows = [...modelIds].map(([id, label]) => ({ label, cells:phases.map(({ sample }) => {
    const model = sample?.multiModel?.models?.find(item => (item.id || item.label) === id);
    return `<span class="forecast-probability">${esc(number(model?.probability, '%'))}</span><small>${esc(number(model?.amount, 'mm'))}</small>`;
  }) }));
  const modelsTable = modelRows.length ? table('비교 예보: Open-Meteo', phases, [
    ...modelRows,
    rawRow('예보 대상', phases.map(phase => stamp(phase.sample?.multiModel?.validAt))),
  ], { note:'윗줄 강수확률 · 아랫줄 1시간 강수량. KMA도 Open-Meteo를 통해 받은 모델 값이에요.',
    url:'https://open-meteo.com/en/docs',
    meta:metadata(phases.map(phase => ({ label:phase.label, meta:phase.sample?.multiModel })), { issued:false })
      + '<p class="forecast-meta">모델 발표 시각은 제공되지 않아요.</p>' }) : '<p class="detail-note">비교 가능한 다른 예보 자료가 없어요.</p>';

  const observations = mode?.immediate && Array.isArray(recent?.observations) ? recent.observations : [];
  const surface = mode?.immediate ? `<div class="detail-fact"><b>노면 추정</b><span>${recent ? '기상청 최근 강수와 시간대 예보로 추정해요. 분석하지 않은 CCTV 영상은 판단에 반영하지 않아요.' : '최근 강수 자료가 없어 노면 상태를 추정하지 않아요.'}</span>${observations.length ? `<ul class="forecast-observations">${observations.map(item => `<li>${esc(stamp(item.observedAt))} 관측 · 1시간 강수량 ${esc(number(item.rainMm, 'mm'))}</li>`).join('')}</ul>` : ''}</div>` : '';

  const samples = phases.map(phase => phase.sample);
  const metrics = samples.map(sample => sample ? runSampleMetrics(sample).expectedAmount : null);
  const evaluated = evaluateRunWindow(samples.filter(Boolean), [], { requireSamples:3 });
  const formula = samples.every(supported) && metrics.every(Number.isFinite) && Number.isFinite(evaluated.summary.estimatedAmount)
    ? `<p class="forecast-formula">${metrics.map((value, index) => `${esc(number(value))} × ${index === 1 ? '0.5' : '0.25'}`).join(' + ')} = ${esc(number(evaluated.summary.estimatedAmount, 'mm'))}</p>` : '';
  return `<p class="detail-note">출발·30분 후·복귀에 대응하는 원자료예요. —는 받은 값이 없다는 뜻이에요. 모든 시각은 한국 시각(KST)이에요.</p>
    <p class="forecast-meta">발표는 제공기관이 예보를 발표한 시각, 수신은 앱이 자료를 받은 시각, 예보 대상은 그 값이 예측하는 시각이에요.</p>
    ${cached ? '<p class="forecast-meta">저장된 자료를 보고 있어요. 아래 수신 시각을 확인해 주세요.</p>' : ''}
    ${villageTable}${ultraTable}${thermalTable}${modelsTable}
    <section class="forecast-source forecast-calculation"><h3>화면 수치 계산</h3><dl>
      <div><dt>강수확률</dt><dd>출발·30분 후·복귀의 기상청 강수확률 중 가장 큰 값을 5% 단위로 반올림해 표시해요.</dd></div>
      <div><dt>1시간 예상 강수량</dt><dd>각 시각에서 비교 모델 강수량의 중앙값을 구하고, 기상청 강수량과 그 값의 중앙값을 사용해요. 기상청은 단기예보를 우선 사용하고, 없으면 초단기예보를 사용해요. 한쪽만 있으면 그 값을 사용해요. ‘1mm 미만’은 계산할 때 0.5mm로 처리해요.</dd><dd>그다음 출발 25% + 30분 후 50% + 복귀 25%로 1시간 누적량을 추정해요. 계산 중 강수량은 소수 첫째 자리로 반올림해요.${formula}</dd></div>
      <div><dt>기온·체감온도</dt><dd>Open-Meteo의 해당 정시 값을 사용해요. 예를 들어 10:20에는 10:00 예보를 쓰고, 요약 카드의 기온은 정수로 반올림해요.</dd></div>
      <div><dt>예보 시각 맞추기</dt><dd>기상청과 비교 모델은 선택 시각에서 45분 이내의 가장 가까운 시간별 예보를 사용해요. 같은 예보 시각에 대응하면 값이 반복될 수 있어요. 원자료의 1시간 강수량과 러닝 1시간 누적 추정치는 시간 구간과 계산 방식이 달라요.</dd></div>
      <div><dt>러닝 판단</dt><dd>강수량과 눈·비 종류를 보고, 기상청 확률과 비교 모델의 시각별 평균 확률 중 높은 쪽을 반영해요. 모델 간 차이와 노면 상태도 함께 확인해요.</dd></div>
    </dl></section>${surface}`;
}
