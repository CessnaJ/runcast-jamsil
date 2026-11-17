import { mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WEAR_BANDS, WEAR_POLICY } from '../assets/weather-domain.mjs';

const root = new URL('../', import.meta.url);
const destination = new URL(process.argv[2] || 'output/imagegen/runcast-wear-guide-typeset.png', root);
const copyFile = new URL('output/imagegen/runcast-wear-guide-copy.json', root);
await mkdir(new URL('./', destination), { recursive: true });
await mkdir(new URL('./', copyFile), { recursive: true });
let lower = WEAR_POLICY.minimumTemperature;
const copy = {
  header: ['RunCast', '체감온도별 러닝 옷차림', '가벼운 1시간 러닝 · 보통 체감 · 팬츠 기준', '바람·강수 없는 기본 조합'],
  cards: WEAR_BANDS.map(band => {
    const label = Number.isFinite(band.below) ? `${lower}~${band.below}°C` : `${lower}°C 이상`;
    lower = band.below;
    return {
      label: label.replaceAll('-', '−'),
      rows: [['겉옷', band.outer], ['상의', band.top], ['하의', band.bottom], ['양말', band.socks], ['보조', band.accessories]]
        .filter(([, value]) => value).map(([label, value]) => ({ label, value: value.replaceAll(' (선택)', '(선택)') })),
    };
  }),
  footer: ['바람·비에 따라 겉옷이 달라질 수 있어요.', '시작 온도 이상 · 끝 온도 미만', '−10°C 미만은 개인별 방한 준비가 필요해요.'],
};
if (copy.cards.length !== 9) throw new Error('The guide artwork requires nine temperature cards.');
await writeFile(copyFile, JSON.stringify(copy, null, 2) + '\n');
execFileSync('swift', [fileURLToPath(new URL('render-wear-guide.swift', import.meta.url)),
  fileURLToPath(new URL('assets/wear-guide-background.png', import.meta.url)),
  fileURLToPath(copyFile), fileURLToPath(destination)], { stdio: 'inherit' });
