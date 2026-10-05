# Zen Protocol – התקנת Node ומיינר

עודכן: 2026-10-05

## סקירה

Node מאמת ומפיץ את הבלוקצ'יין; מיינר הוא node שגם כורה בלוקים ומקבל 25 ZP לבלוק. Node רץ על שרת בענן, וכרייה רק על מחשב בבעלותך, כי ספקי ענן אוסרים כרייה.

| מכונה | תפקיד | שיטה | כרייה |
| --- | --- | --- | --- |
| שרת Linux (Ubuntu, למשל Hetzner) | Node ציבורי, זמין 24/7 | Docker, סקריפט setup | אסורה |
| מחשב Windows בבית | Node + מיינר | Docker Desktop | מותרת |

כל ההתקנות משתמשות בגרסה הרשמית 1.0.13, הראשונה ללא תאריך תפוגה.

## שרת Linux (Node בלבד)

סקריפט אחד מתקין Docker ומפעיל node ללא כרייה, מוגבל לליבה אחת ו-2GB, כך שהוא לא מפריע לשירותים אחרים בשרת.

1. מ-PowerShell במחשב: `ssh root@<IP-של-השרת>`
2. מומלץ לעדכן קודם: `apt update && apt upgrade -y` ואז `reboot`
3. להוריד ולהריץ את הסקריפט:

```
curl -fsSL https://raw.githubusercontent.com/alonp1/zenprotocol/node-upgrade-script/scripts/setup-zen-node-server.sh -o setup.sh
bash setup.sh
```

הסקריפט בודק שיש 20GB פנויים ושהפורטים 9655 ו-11567 פנויים, מתקין Docker, מוריד את הקוד ל-`~/zenprotocol` ומפעיל את ה-node.

**האצת הסנכרון** (הסנכרון הראשוני לוקח כ-10–20 שעות):

```
cd /root/zenprotocol
echo "ZEN_CPUS=2.0" >> .env
docker compose up -d
```

אחרי שהסנכרון מסתיים, להחזיר ל-`ZEN_CPUS=1.0` בקובץ `.env` ולהריץ שוב `docker compose up -d`.

**חומת אש:** פורט 9655/TCP צריך להיות פתוח לתעבורה נכנסת. אם משתמשים ב-Hetzner Cloud Firewall, להוסיף שם חוק. פורט ה-API (11567) נשאר סגור ונגיש רק מהשרת עצמו.

**אין להפעיל כרייה על השרת.** תנאי השימוש של Hetzner ו-DigitalOcean אוסרים כרייה.

## Windows (Node + מיינר)

ב-Windows מריצים רק דרך Docker Desktop. התקנה ישירה דרך npm נכשלת ביצירת ארנק (שגיאת `cannot derive`).

1. ב-PowerShell: `winget install Git.Git Docker.DockerDesktop`, ואז הפעלה מחדש של המחשב
2. לפתוח את Docker Desktop ולחכות ל-**Engine running** (אם מתבקשת התקנת WSL ויצירת משתמש Ubuntu, לאשר)
3. בחלון PowerShell חדש:

```
git clone -b node-upgrade-script https://github.com/alonp1/zenprotocol.git
cd zenprotocol
docker compose up -d --build
```

4. לבדוק שה-container יציב: `docker compose ps` צריך להראות **Up**, לא Restarting
5. ליצור ארנק חדש למיינר (לא הארנק הראשי):

```
docker compose exec zen-node mono zen-cli.exe wallet-create
docker compose exec zen-node mono zen-cli.exe mnemonicphrase
docker compose exec zen-node mono zen-cli.exe address
```

`wallet-create` לא מציג את 24 המילים; `mnemonicphrase` מציג אותן. לרשום על נייר.

6. להאיץ את הסנכרון בזמן ההמתנה: `Set-Content .env "ZEN_CPUS=3.0"` ואז `docker compose up -d`
7. אחרי שהסנכרון מסתיים, להפעיל כרייה:

```
Set-Content .env "MINER_THREADS=2`nZEN_CPUS=2.0"
docker compose up -d
```

**הגדרות Windows לכרייה רציפה:**

- Settings ← System ← Power ← Sleep: **Never** כשהמחשב מחובר לחשמל
- Docker Desktop ← Settings ← General: לסמן **Start Docker Desktop when you sign in**

## פקודות שימושיות

כל הפקודות רצות מתוך תיקיית `zenprotocol`. ב-Windows להשתמש ב-`curl.exe` במקום `curl`.

| מטרה | פקודה |
| --- | --- |
| מצב סנכרון | `curl -s http://127.0.0.1:11567/blockchain/info` |
| מספר nodes מחוברים | `curl -s http://127.0.0.1:11567/network/connections/count` |
| יתרת ארנק המיינר | `docker compose exec zen-node mono zen-cli.exe balance` |
| לוגים | `docker compose logs -f --tail 50` |
| מצב ה-container | `docker compose ps` |
| עצירה | `docker compose down` |
| הפעלה מחדש עם הגדרות `.env` | `docker compose up -d` |
| עדכון לקוד האחרון מה-fork | `git pull` ואז `docker compose up -d --build` |

הסנכרון הסתיים כש-`blocks` שווה ל-`headers` ו-`initialBlockDownload` הוא `false`. השוואה לסייר: [zp.io](https://zp.io).

## אבטחה ותקלות ידועות

**אבטחה**

- 24 המילים של כל ארנק נרשמות על נייר בלבד, ולא נשלחות לאף אחד. מי שמחזיק אותן שולט במטבעות.
- הארנק הראשי עם ה-ZP לא מיובא לאף node. הצבעות נעשות ממנו דרך wallet.zp.io.
- פורט ה-API (11567) נגיש רק מהמכונה עצמה. הוא שולט בארנק, ולכן לא נפתח לעולם.
- תיקיית `zen-data` מכילה את הבלוקצ'יין ואת הארנק. לא למחוק אותה.

**תקלות ידועות**

| תקלה | סיבה | פתרון |
| --- | --- | --- |
| `npm.ps1 cannot be loaded` | PowerShell חוסם סקריפטים | `npm.cmd` במקום `npm` |
| `is not a valid npm option` | תחביר npm חדש ו-`@` ב-PowerShell | `npm.cmd config set "@zen:registry=https://..."` |
| `cannot derive` ב-Windows | ה-node לא נתמך ב-Windows | Docker Desktop |
| Container ב-Restarting | סופי שורות של Windows בסקריפט | `git pull` ו-`docker compose up -d --build` (תוקן ב-fork) |
| גרסאות לפני 1.0.13 | תאריך תפוגה מובנה | רק 1.0.13 |
