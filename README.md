# letscareer.job 성과 대시보드

- 수집: `.github/workflows/sync.yml`이 매일 한국시간 오전 8시에 `scripts/sync.mjs` 실행
- 대상: letscareer.job 인스타그램 게시물(2026-01-01 이후), 캠페인명에 '오공고'가 포함된 광고
- 결과: `docs/data/posts.json`, `docs/data/sync.json`, `docs/covers/`
- 화면: `docs/index.html`

## 처음 설정
1. 저장소 Settings → Secrets and variables → Actions → `META_ACCESS_TOKEN` 등록
2. Actions 탭 → "메타 성과 수집" → Run workflow로 첫 실행
3. 호스팅의 배포 폴더를 `docs`로 지정

## 로컬에서 보기
`npx serve docs` 후 브라우저에서 열기 (파일을 더블클릭하면 데이터를 못 읽음)
