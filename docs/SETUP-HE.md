# ZP – התקנת Node ומיינר

עודכן: 2026-10-06

## סקירה

Node מאמת ומפיץ את הבלוקצ'יין. מיינר הוא node שגם כורה בלוקים ומקבל 25 ZP לבלוק. Node רץ על שרת בענן, וכרייה רק על מחשב בבעלותך, כי ספקי ענן אוסרים כרייה.

| מכונה | תפקיד | שיטה | כרייה |
| --- | --- | --- | --- |
| שרת Linux (Ubuntu) | Node ציבורי, seed, דף סטטוס וגיבויים | Docker + Nginx | אסורה |
| מחשב Windows בבית | Node + מיינר | Docker Desktop | מותרת |

כל ההתקנות משתמשות בגרסה הרשמית 1.0.13, הראשונה ללא תאריך תפוגה. node חדש נטען מגיבוי עדכני ומסונכרן תוך דקות.

## תשתית קהילתית

| רכיב | כתובת |
| --- | --- |
| דף סטטוס רשת והורדות | [zen.sealinkgps.com](https://zen.sealinkgps.com) |
| Seed node | `zen.sealinkgps.com:9655` (מוגדר מראש ב-image) |
| גיבוי עדכני | [zen.sealinkgps.com/snapshots](https://zen.sealinkgps.com/snapshots/) |
| קוד | [github.com/alonp1/zenprotocol](https://github.com/alonp1/zenprotocol/tree/node-upgrade-script) |

הדף חושף רק שני נתיבים לקריאה בלבד מה-node (`/api/info`, `/api/peers`). ה-API של הארנק סגור.

## שרת Linux (Node בלבד)

1. מ-PowerShell במחשב: `ssh root@<IP-של-השרת>`
2. מומלץ לעדכן קודם: `apt update && apt upgrade -y` ואז `reboot`
3. התקנה:

```
curl -fsSL https://raw.githubusercontent.com/alonp1/zenprotocol/node-upgrade-script/scripts/setup-zen-node-server.sh -o setup.sh
bash setup.sh
```

הסקריפט בודק שיש 20GB פנויים ושהפורטים 9655 ו-11567 פנויים, מתקין Docker, מוריד את הקוד ל-`~/zenprotocol` ומפעיל node מוגבל לליבה אחת ו-2GB, כך שהוא לא מפריע לשירותים אחרים בשרת.

4. טעינת הגיבוי (במקום סנכרון של שעות):

```
cd /root/zenprotocol
docker compose down
docker compose run --rm --no-deps --entrypoint /load-snapshot.sh zen-node
docker compose up -d
```

**חומת אש:** פורט 9655/TCP פתוח לתעבורה נכנסת (ב-Hetzner Cloud Firewall, אם בשימוש). פורט ה-API (11567) נשאר נגיש רק מהשרת עצמו.

**אין להפעיל כרייה על השרת.** תנאי השימוש של Hetzner ו-DigitalOcean אוסרים כרייה.

### דף הסטטוס והגיבויים (פעם אחת)

דורש רשומת A ב-DNS לשרת (ב-Cloudflare: **DNS only**, ענן אפור – הפרוקסי לא מעביר את פורט 9655).

```
cd /root/zenprotocol
bash site/setup-site.sh
```

הסקריפט מוסיף אתר נפרד ל-Nginx (לא נוגע באתרים קיימים), מפרסם את הגיבוי האחרון ומנפיק אישור HTTPS שמתחדש אוטומטית. לדומיין אחר: `DOMAIN=example.org bash site/setup-site.sh`.

### עדכון הגיבוי (פעם בחודש)

```
cd /root/zenprotocol
H=$(curl -s http://127.0.0.1:11567/blockchain/info | grep -o '"blocks":[0-9]*' | cut -d: -f2)
docker compose down
docker compose run --rm --no-deps --entrypoint /create-snapshot.sh zen-node $H
docker compose up -d
bash site/setup-site.sh
```

ה-node כבוי כ-10 דקות בזמן הכיווץ. הגיבוי לא כולל ארנקים. גיבויים ישנים ב-`zen-data/snapshots` אפשר למחוק ידנית.

## Windows (Node + מיינר)

ב-Windows מריצים רק דרך Docker Desktop. התקנה ישירה דרך npm נכשלת ביצירת ארנק (שגיאת `cannot derive`).

1. ב-PowerShell: `winget install Git.Git Docker.DockerDesktop`, ואז הפעלה מחדש של המחשב
2. לפתוח את Docker Desktop ולחכות ל-**Engine running** (אם מתבקשת התקנת WSL ויצירת משתמש Ubuntu – לאשר)
3. התקנה וטעינת גיבוי, בחלון PowerShell **אחד** (שתי הורדות במקביל משחיתות את הקובץ):

```
cd C:\Users\<user>
git clone -b node-upgrade-script https://github.com/alonp1/zenprotocol.git
cd zenprotocol
Set-Content .env "ZEN_CPUS=3.0`nZEN_DATA=zen-data"
docker compose build
docker compose run --rm --no-deps --entrypoint /load-snapshot.sh zen-node
docker compose up -d
```

`ZEN_DATA=zen-data` שומר את הנתונים ב-volume של Docker. בלעדיו הם נשמרים בתיקיית Windows, והסנכרון איטי פי 4.

4. לבדוק: `docker compose ps` מראה **Up** (לא Restarting), ו-`curl.exe -s http://127.0.0.1:11567/blockchain/info` מראה `blocks` שווה ל-`headers`
5. ארנק חדש למיינר (לא הארנק הראשי):

```
docker compose exec zen-node mono zen-cli.exe wallet-create
docker compose exec zen-node mono zen-cli.exe mnemonicphrase
```

לרשום את 24 המילים על נייר, לנקות את המסך (`cls`) ורק אז:

```
docker compose exec zen-node mono zen-cli.exe address
```

6. הפעלת כרייה (אחרי שהסנכרון הושלם):

```
Set-Content .env "MINER_THREADS=2`nZEN_CPUS=2.0`nZEN_DATA=zen-data"
docker compose up -d
```

בלוג יופיעו שורות `GetBlockTemplate` – זה הכורה שמבקש עבודה. תגמול של בלוק שנכרה ננעל ל-100 בלוקים לפני שאפשר להשתמש בו.

**הגדרות Windows לכרייה רציפה:**

- Settings ← System ← Power ← Sleep: **Never** כשהמחשב מחובר לחשמל
- Docker Desktop ← Settings ← General: לסמן **Start Docker Desktop when you sign in**

**החלפת ארנק המיינר** (למשל אם המילים נחשפו):

```
docker compose exec zen-node mono zen-cli.exe removewallet
docker compose exec zen-node mono zen-cli.exe wallet-create
```

`removewallet` מבקש את סיסמת הארנק הנוכחי.

## פקודות שימושיות

כל הפקודות רצות מתוך תיקיית `zenprotocol`. ב-Windows להשתמש ב-`curl.exe` במקום `curl`.

| מטרה | פקודה |
| --- | --- |
| מצב סנכרון | `curl -s http://127.0.0.1:11567/blockchain/info` |
| מספר nodes מחוברים | `curl -s http://127.0.0.1:11567/network/connections/count` |
| יתרת ארנק המיינר | `docker compose exec zen-node mono zen-cli.exe balance` |
| היסטוריית ארנק | `docker compose exec zen-node mono zen-cli.exe history` |
| לוגים | `docker compose logs -f --tail 50` |
| מצב ה-container | `docker compose ps` |
| עצירה | `docker compose down` |
| הפעלה מחדש עם הגדרות `.env` | `docker compose up -d` |
| עדכון לקוד האחרון | `git pull` ואז `docker compose up -d --build` |

הסנכרון הסתיים כש-`blocks` שווה ל-`headers` ו-`initialBlockDownload` הוא `false`. השוואה: [zen.sealinkgps.com](https://zen.sealinkgps.com) או [zp.io](https://zp.io).

## אבטחה ותקלות ידועות

**אבטחה**

- 24 המילים של כל ארנק נרשמות על נייר בלבד, ולא נשלחות לאף אחד ולא מופיעות בצילומי מסך. מי שמחזיק אותן שולט במטבעות.
- הארנק הראשי עם ה-ZP לא מיובא לאף node. הצבעות נעשות ממנו, מהארנק הייעודי.
- פורט ה-API (11567) נגיש רק מהמכונה עצמה. הוא שולט בארנק, ולכן לא נפתח לעולם.
- הנתונים (בלוקצ'יין וארנק) נמצאים ב-volume `zenprotocol_zen-data` ב-Windows, וב-`zen-data` בשרת. לא למחוק.

**תקלות ידועות**

| תקלה | סיבה | פתרון |
| --- | --- | --- |
| `npm.ps1 cannot be loaded` | PowerShell חוסם סקריפטים | `npm.cmd` במקום `npm` |
| `is not a valid npm option` | תחביר npm חדש ו-`@` ב-PowerShell | `npm.cmd config set "@zen:registry=https://..."` |
| `cannot derive` ב-Windows | ה-node לא נתמך ב-Windows | Docker Desktop |
| Container ב-Restarting | סופי שורות של Windows בסקריפט | `git pull` ו-`docker compose up -d --build` |
| `invalid compressed data` | הורדה פגומה (למשל שתי הורדות במקביל) | הקובץ נמחק אוטומטית – להריץ שוב את הטעינה |
| `no configuration file provided` | הפקודה רצה מחוץ לתיקיית `zenprotocol` | `cd zenprotocol` |
| `account already exist` | יש כבר ארנק ב-node | `removewallet` ואז `wallet-create` |
| סנכרון איטי ב-Windows | נתונים בתיקיית Windows | `ZEN_DATA=zen-data` ב-`.env` וטעינה מחדש של הגיבוי |
| גרסאות לפני 1.0.13 | תאריך תפוגה מובנה | רק 1.0.13 |
