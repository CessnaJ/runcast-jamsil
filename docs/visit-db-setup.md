# Vercel 무료 PostgreSQL 연결

Vercel 프로젝트에서 **Storage → Create Database → Neon → Free ($0)**로 생성하고 이 프로젝트에 연결한다. Vercel Postgres 자체 상품은 종료되어 현재는 Marketplace의 Neon PostgreSQL을 사용한다. Redis는 사용하지 않는다.

## 1. Vercel에서 준비

1. [Vercel Neon](https://vercel.com/marketplace/neon) 또는 프로젝트 Storage에서 Neon을 선택한다.
2. **Free ($0)** 플랜인지 확인한다. 유료 플랜·유료 추가 기능으로 올리지 않는다.
3. 가능하면 Vercel 함수의 서울(`icn1`)과 가까운 DB 지역을 선택한다.
4. 프로젝트에 연결하고 **Production** 환경의 `DATABASE_URL`이 생성됐는지 확인한다. 풀링 주소(호스트에 `-pooler` 포함)를 사용하고 공급자가 넣은 TLS 설정을 유지한다.
5. 개발·미리보기에도 연결할 수 있다. 서버가 `VERCEL_ENV`로 `production`, `preview`를 구분하므로 운영 집계와 섞이지 않는다. 강한 데이터 격리가 필요하면 별도 Neon 브랜치/DB를 연결한다.

Vercel Hobby의 실행 메모리는 DB가 아니다. 이 설정을 해야 재시작·재배포 후에도 기록이 남는다. 코드만 배포해도 DB가 자동 생성되는 것은 아니다.

## 2. 테이블 준비

Node.js 20.12 이상과 npm을 사용한다. 먼저 프로젝트 루트에서 `npm ci`를 실행한다.

이미 Vercel CLI에 로그인한 경우 운영 환경변수를 **Git에서 무시하는 별도 파일**로 받아 준비할 수 있다. 기존 날씨 키가 있는 `.env.local`을 덮어쓰지 않는다.

```sh
npx vercel link
npx vercel env pull .env.stats.local --environment=production
VISIT_STATS_SCOPE=production node --env-file=.env.stats.local scripts/visit-db.mjs setup
VISIT_STATS_SCOPE=production node --env-file=.env.stats.local scripts/visit-db.mjs check
```

대안: Vercel/Neon에서 복사한 `DATABASE_URL`을 로컬 `.env.local`에 넣고 아래를 실행한다. 주소에는 비밀번호가 있으므로 채팅·커밋·스크린샷에 올리지 않는다.

```sh
VISIT_STATS_SCOPE=production npm run db:setup
VISIT_STATS_SCOPE=production npm run db:check
```

준비 명령은 `db/migrations/001_visit_stats.sql`을 적용하고 해당 환경의 집계 시작 시각을 기록한다. 같은 명령을 다시 실행해도 기존 합계를 지우거나 시작 시각을 변경하지 않는다. 애플리케이션의 `DATABASE_URL`과 같은 DB 소유자 계정으로 실행한다.

로컬 테스트에는 별도 개발 DB/브랜치를 권장한다. 로컬 서버 기본 scope는 `development`다. 운영 URL로 테스트하면서 `VISIT_STATS_SCOPE=production`을 설정하면 운영 통계가 바뀌므로 구분해서 사용한다.

## 3. 배포와 확인

테이블을 준비한 뒤 새 환경변수가 적용되도록 배포한다. Vercel이 `package.json`의 운영 의존성 `pg`를 설치한다. 빌드 과정에 마이그레이션을 자동 실행하지 않는다.

- 휴대폰으로 열면 하루 한 번 `POST /api/visit-stats`가 등록된다.
- `GET /api/visit-stats?days=14` 또는 더 보기 → 통계 보기에서 최근 14일을 확인한다.
- 앱을 닫고 다시 열어도 오늘 수치는 증가하지 않아야 한다.
- 다른 휴대폰은 1대 추가되고, 재배포 후에도 합계가 유지되어야 한다.
- DB 미연결은 503 `STATS_DB_NOT_CONFIGURED`, 연결/스키마 오류는 503 `STATS_UNAVAILABLE`다. 메모리 집계로 대체하거나 0으로 오인시키지 않는다. 다른 날씨 기능은 계속 동작한다.
- `npm run db:check`는 합계 날짜 수, 최근 중복 확인 행 수, 집계 시작 시각, 테이블·인덱스 바이트를 출력한다. ID·접속 비밀번호는 출력하지 않는다.

## 무료 할당량과 저장량

2026-11-07 확인 기준 Neon Free는 프로젝트당 PostgreSQL 저장 공간 **1GB**, 연산 **월 100 CU-hours**를 제공한다. Vercel에서 생성할 때 표시되는 실제 Free 플랜 한도도 확인한다. Vercel Hobby 요금제와 DB 제공자의 무료 할당량은 별개다.

하루 100기기, 20년을 가정하면 일별 합계 약 7,305행, 중복 확인 약 1,400행과 환경 상태 1행이다. 개별 ID는 다음 방문일의 정리 시점에 최근 14일 범위 밖을 삭제하며 일별 합계는 계속 보관한다. 전용 유료 cron이나 Redis는 필요 없다. 방문이 없는 기간에는 정리가 실행되지 않지만 새 행도 생기지 않고, 다음 쓰기 때 정리한다.

기기당 하루 등록 완료를 저장해 5분마다 재등록하지 않는다. 통계 화면을 열거나 새로고침할 때만 최근 14일을 조회하고, 날짜를 누르는 동작은 추가 조회를 만들지 않는다. 저장 공간은 매우 작지만 연산·전송량 등 모든 무료 한도를 무조건 보장할 수는 없으므로 대시보드에서 실제 사용량을 확인한다. 공급자의 20년 무료 정책을 보장하는 설계는 아니다.

설계와 자료구조: [방문 통계 설계](visit-stats-14-day-design.md).

공식 자료: [Postgres on Vercel](https://vercel.com/docs/postgres), [Vercel Neon 연결](https://vercel.com/marketplace/neon), [Neon Free 1GB 안내](https://neon.com/blog/neon-free-plan-1-gb-per-project).
