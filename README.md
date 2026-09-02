# RunCast 잠실

잠실에서 30분 뒤 출발해 1시간 달려도 되는지를 판단하는 러닝 날씨 대시보드입니다.

## 실행

1. VS Code에서 이 `jamsil-run-radar` 폴더를 엽니다.
2. `F5`를 누릅니다.
3. `RunCast 잠실 열기`를 선택하면 로컬 서버와 브라우저가 함께 열립니다.

Live Server나 별도 터미널은 필요하지 않습니다. Node.js 20 이상이면 실행되며, 로그인된 Codex CLI가 있으면 로컬 전용 노면 CCTV AI 분석도 사용할 수 있습니다.

## 모바일 화면

- 화면 폭이 767px 이하이면 `/mobile.html`로 자동 전환됩니다.
- PC에서 모바일 화면을 바로 보려면 `http://127.0.0.1:4173/mobile.html`을 엽니다.
- 휴대폰에서도 데스크톱 화면을 확인하려면 주소 끝에 `?view=desktop`을 붙입니다.
- 모바일 화면은 기존 서버 API를 공유하며, 공개 배포에서는 CCTV 원본 링크만 제공하고 로컬 Codex AI 분석은 비활성화됩니다.

## 실시간 자료 연결

키는 Git과 Vercel 업로드에서 제외되는 `.env.local`에 모아 두며 서버 시작 시에만 읽습니다. 화면 오른쪽 위의 `⚙` 버튼은 실제 값을 보여주지 않고 연결 여부만 표시합니다.

기상청 동네예보·API허브·ITS 키는 브라우저로 전달하거나 요청 본문에 넣지 않습니다. Naver Maps Client ID만 지도 JavaScript SDK 구동을 위해 브라우저에 전달되는 공개 식별자입니다.

```dotenv
NAVER_MAP_CLIENT_ID=...
KMA_SERVICE_KEY=...
KMA_HUB_KEY=...
ITS_API_KEY=...
```

- Naver Maps `ncpKeyId`: Dynamic Map을 활성화하고 웹 서비스 URL에 `http://127.0.0.1:4173`을 등록합니다.
- 기상청 동네예보 서비스키: 공공데이터포털의 `기상청_단기예보 ((구)_동네예보) 조회서비스` 일반 인증키를 사용합니다.
- ITS API 키: 국가교통정보센터에서 `CCTV 화상자료`를 신청합니다. Codex 분석에는 정지영상 유형이 필요합니다.
- 기상청 API허브 키: `레이더 강수량` 활용신청 후 발급된 키를 사용합니다. 타임라인을 누르면 해당 시각의 MAPLE 초단기 강수예측 분포도가 지도 안에서 갱신됩니다.

기상청 예보 키가 없거나 호출이 일시적으로 실패하면 시각화 확인용 샘플 예보와 `SAMPLE` 표시가 나타납니다. ITS 키가 없으면 CCTV는 가짜 자료로 대체하지 않고 화면과 판정에서 제외합니다.

## 로컬 모드와 공개 배포 모드

- 로컬에서 `F5`로 실행하면 기본적으로 `local` 모드입니다. Codex CLI가 연결된 경우에만 `노면 CCTV AI 분석` 버튼이 활성화됩니다.
- Vercel에서는 `VERCEL` 환경변수를 감지해 자동으로 `public` 모드가 됩니다. AI 버튼이 비활성화되고 서버의 `/api/analyze`도 `403`으로 차단됩니다.
- 공개 모드에는 OpenAI API 키나 Codex 인증정보가 필요하지 않습니다. 키가 전혀 없어도 빌드되며, 없는 날씨 자료는 샘플 또는 `자료 없음`으로 처리됩니다.
- 공개 모드를 로컬에서 시험하려면 `RUNCAST_MODE=public RUNCAST_PORT=4174 node server.mjs`를 실행합니다.
- AI를 로컬에서도 끄려면 `RUNCAST_AI_ENABLED=0 node server.mjs`를 사용합니다.

## Vercel 배포

프로젝트 루트를 Vercel에 연결하고 Framework Preset을 `Other`로 선택합니다. 별도 Build Command나 Output Directory는 입력하지 않습니다. `index.html`은 정적 파일로, `api/[...path].mjs`는 Node 함수로 배포됩니다.

필요하면 Vercel 프로젝트의 Environment Variables에 아래 무료 데이터 키를 등록합니다.

```dotenv
NAVER_MAP_CLIENT_ID=...
KMA_SERVICE_KEY=...
KMA_HUB_KEY=...
ITS_API_KEY=...
```

AI 관련 환경변수나 키는 등록하지 않습니다. 배포가 끝나면 Naver Maps 애플리케이션의 허용 웹 서비스 URL에 실제 Vercel 도메인을 추가해야 지도가 표시됩니다.

## 판정 원칙

- 핵심 구간은 `현재+30분 출발`부터 `현재+90분 복귀`까지의 1시간입니다.
- 기상청 초단기예보가 러닝 구간의 시간 판단을 담당합니다.
- 기상청 API허브의 초단기 강수예측 분포도는 `+30분/+1시간/+3시간/+6시간`의 공간 분포 확인에 사용합니다.
- 로컬 모드의 노면 CCTV AI 분석은 15초 간격 이미지 두 장으로 현재 비와 노면을 확인합니다. 공개 배포에서는 완전히 차단됩니다.
- 방향별 CCTV 카드를 누르면 AI 없이도 원본 영상을 새 창에서 직접 확인할 수 있습니다.
- METAR/TAF는 보조 자료일 뿐 최종 판단의 주 근거로 사용하지 않습니다.
- CCTV가 젖은 노면만 보여주는 경우에는 비로 단정하지 않습니다.

이 화면은 개인 의사결정 보조 도구이며 공식 기상특보를 대체하지 않습니다.
