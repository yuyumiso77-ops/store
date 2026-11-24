# 매장 상품 고객 반응 조사

매장 직원이 상품을 안내·판매하면서 **고객 반응, 장단점, 개선 아이디어**를 기록하고,
관리자가 상품별로 모아 분석하는 웹 앱입니다. 외부 패키지 없이 Node.js(18 이상)만 있으면 실행됩니다.

## 실행

```bash
ADMIN_PASSWORD=관리자비번 STAFF_PASSWORD=직원비번 npm start
```

- 직원 기록 화면: http://localhost:3000 (비밀번호 `STAFF_PASSWORD`, 관리자 비밀번호로도 접속 가능)
- 관리자 분석 화면: http://localhost:3000/admin (비밀번호 `ADMIN_PASSWORD`)
- 아이디 칸은 아무거나 입력하면 됩니다.

| 환경변수 | 기본값 | 설명 |
|---|---|---|
| `PORT` | `3000` | 서버 포트 |
| `ADMIN_PASSWORD` | `admin1234` | 관리자 비밀번호 (**꼭 바꾸세요**) |
| `STAFF_PASSWORD` | (없음) | 직원 기록 화면 비밀번호. 비워두면 누구나 기록 가능 |
| `DATA_DIR` | `./data` | 데이터 저장 폴더 (`db.json`) |

## 사용 방법

1. 관리자 화면에서 조사할 **상품을 등록**합니다.
2. 직원은 휴대폰으로 기록 화면을 열어 고객 응대 후 바로 기록합니다.
   - 고객 반응 (매우 부정적 ~ 매우 긍정적)
   - 구매 결과 (구매함 / 고민 후 보류 / 구매 안 함) + 구매하지 않은 이유
   - 고객이 좋다고 한 점 / 아쉽다고 한 점 (항목 선택 + 메모)
   - 개선 아이디어·고객 요청, 고객층(연령대·성별, 선택)
   - 직원 이름과 마지막 상품은 기억되어 연속 기록이 빠릅니다.
3. 관리자 화면에서 상품별 평균 반응, 구매율, 장점·단점·미구매 이유 순위, 직원 메모를 확인합니다.
4. **CSV 내려받기**로 전체 기록을 엑셀에서 열 수 있습니다.
5. 조사가 끝난 상품은 **조사 중지**를 누르면 기록 화면에서 빠집니다. 기존 기록은 남습니다.

## 테스트

```bash
npm test
```

## Railway 배포

1. https://railway.com 에 GitHub 계정으로 로그인합니다.
2. **New Project → Deploy from GitHub repo → `store`** 를 선택합니다.
   (저장소가 안 보이면 *Configure GitHub App*에서 `store` 접근을 허용하세요.)
3. 서비스의 **Variables** 탭에서 아래 두 값을 추가합니다.
   - `ADMIN_PASSWORD` = 관리자 비밀번호
   - `STAFF_PASSWORD` = 직원용 비밀번호 (기록 화면 접속용)
   - `DATA_DIR` = `/data`
4. 서비스를 우클릭(또는 ⌘K) → **Attach Volume** → Mount path에 `/data` 를 입력합니다.
   이 볼륨이 있어야 재배포해도 응답이 지워지지 않습니다.
5. **Settings → Networking → Generate Domain** 을 누르면 `https://….up.railway.app` 주소가 생깁니다.
6. 그 주소 + `/admin` 으로 들어가 상품을 등록하고 QR을 인쇄하면 끝입니다.

이후 `main` 브랜치에 push하면 Railway가 자동으로 다시 배포합니다.
