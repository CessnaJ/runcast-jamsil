# 주간 예보 장애 로그와 PostgreSQL 저장

주간 예보의 마지막 성공 원천 응답을 기존 `DATABASE_URL`의 PostgreSQL에 저장한다. 운영·미리보기·개발은 `VERCEL_ENV`(로컬 기본 `development`)로 구분한다. 별도 DB 상품이나 Redis를 추가하지 않는다.

## 테이블 준비와 배포

기존 방문 통계와 같은 DB 소유자 연결을 사용한다. 설정되어 있다면 새로운 환경변수는 필요 없다. Git에서 무시하는 `.env.local`에 `DATABASE_URL`을 준비한 뒤 실행한다.

```sh
npm run weather-cache:setup
npm run weather-cache:check
```

운영 환경변수 파일을 이미 별도로 받아 두었다면 아래처럼 환경을 지정한다. 기존 `.env.local`을 덮어쓰거나 연결 문자열을 채팅·로그·공개 파일에 복사하지 않는다.

```sh
VERCEL_ENV=production node --env-file=.env.stats.local scripts/weather-cache-db.mjs setup
VERCEL_ENV=production node --env-file=.env.stats.local scripts/weather-cache-db.mjs check
```

`setup`은 `db/migrations/002_weather_cache.sql`만 적용하며 여러 번 실행해도 기존 자료와 방문 통계를 지우지 않는다. 빌드/실행 중 DDL을 자동 실행하지 않는다. 테이블을 준비한 뒤 해당 코드를 배포한다. `check`는 좌표·예보 본문 대신 저장 건수, 사용 가능한 건수, 마지막 성공 시각, 저장 용량만 출력한다.

## 동작

- 주간 예보 원천 성공 시 응답과 원래 수집 시각을 저장한다. 같은 인스턴스의 진행 중 요청은 DB 조회부터 공급자 호출·저장까지 하나로 합친다.
- 메모리의 30분 TTL이 끝났거나 새 인스턴스라면 DB를 조회한다. DB 자료도 신선하면 외부 API를 다시 부르지 않는다.
- 오래된 자료는 원천 API 갱신에 실패했을 때만 반환한다. 원래 `fetchedAt`·`expiresAt`를 유지하고 `refresh.stale: true`, `retryAt`를 전달해 기존 화면에서 ‘이전 자료’로 표시한다.
- 최대 7일 이내의 성공 자료만 복구한다. 한국 날짜가 바뀌면 오늘을 기준으로 남아 있는 예보 날짜를 고르고, 없는 미래 날짜를 채우지 않는다. 현재 날짜 이후의 일별 자료가 없는 응답은 사용하지 않는다.
- 캐시 키는 위치 좌표·원천 계약 버전으로 구분한다. 요청 이름, 기기 ID, 인증키, 실패 응답은 DB에 저장하지 않는다. 늦게 끝난 과거 요청이 더 최신 자료를 덮지 못한다.
- 한 환경당 최근 120개 위치를 기준으로 쓰기 때 오래된 행을 정리한다. 동시 인스턴스의 쓰기로 일시적으로 초과할 수 있으며 다음 쓰기 때 다시 정리한다. 별도 cron은 없다.
- DB 연결/쿼리 제한은 각각 2초다. DB 장애·미설정·테이블 미준비로 정상 공급자 응답까지 실패시키지 않는다. 메모리/브라우저 캐시는 계속 동작한다. 모든 인스턴스가 공유하는 원천 호출 잠금이나 실패 재시도 제한은 제공하지 않는다.
- 저장할 성공 자료가 아직 한 번도 없으면 외부 API 장애를 캐시로 복구할 수 없다. 이 경우 정상적으로 실패를 반환하며 다음 재시도 시각을 전달한다.

## Vercel Logs에서 확인

`[UPSTREAM_HTTP]`는 실제 원천 네트워크 요청의 실패마다 한 줄을 남긴다. HTTP 실패·DNS 오류·연결 시간 초과·TLS 오류·전체 시간 제한·JSON 오류를 `failure`로 구분하며, `phase`는 응답 헤더 대기(`headers`) 또는 본문 읽기/파싱(`body`)이다. 실제 소켓 이벤트를 관찰한 DNS/TCP/TLS 단계와는 다르다.

확인 필드: `version`, `requestId`, `provider`, `dataset`(주간/다중모델), `host`, `failure`, `phase`, `statusCode`, `durationMs`, `configuredTimeoutMs`, `errorCode`, `causeCodes`, `region`, `commit`, `node`. 예를 들어 `errorCode: UND_ERR_CONNECT_TIMEOUT`은 설정된 전체 15초 제한보다 Node의 연결 제한이 먼저 끝났음을 구분하는 데 도움이 된다. HTTP 429/503이면 상태와 공급자의 `Retry-After`를 구분할 수 있다.

`[WEATHER_CACHE]`는 DB `read`/`write` 오류와 미설정(`disabled`)을 구분한다. `42P01`은 테이블 준비 여부를 확인한다. DB가 없으면 `DB_NOT_CONFIGURED`를 인스턴스당 한 번 기록한다. 원천 캐시에서 응답하면 외부 네트워크 오류 로그를 추가하지 않는다.

어느 로그에도 URL 쿼리, 좌표, 헤더, 응답 본문, DB 연결 문자열, 원본 오류 메시지/스택은 남기지 않는다. 현재 로그는 진단용이며 공급자의 장애나 네트워크 차단 자체를 복구하지 않는다.
