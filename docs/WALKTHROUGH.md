# Happy-path walkthrough (about 5 minutes)

One partner's sale, followed from signup to money in their account, across the app and the dashboard. Every step uses the seeded demo data; the password for all demo accounts is `Demo@1234`.

You need:
- the **app**: the APK on an Android phone, or `npx expo start --web` in `partners-app`
- the **dashboard**: the live URL, or `npm run dev` in `partners-dashboard`

## 1. A teacher joins (app, about 1 minute)

1. Open the app. Before asking for anything, the Welcome screen shows the deal: students get 10% off, the partner earns 12%, payouts are every Friday. Move the calculator slider: 8 students a month comes to roughly ₹2,500 a month.
2. Tap **Create partner account**. Fill in name, email, mobile and password, and choose *Yoga teacher*.
3. **Pick your code.** The app suggests one from your name. Type `PRIYA10` to see it's taken, and the app suggest free alternatives; then pick your own, e.g. `ZOYA10`.
4. The code is live immediately. Tap **Share** and the message carries the code and the share link.

> Why: signups grow when the value is visible up front and the first win is instant. Bank details and PAN are asked for only later, once there's money to send.

## 2. A student orders with the code (dashboard, 30 seconds)

The real store would send a signed webhook (`npm run simulate:order -- ZOYA10` does exactly that). In the dashboard you can do the same with a button:

1. Log in as **admin@partners.demo**, click **Simulate an order**, enter the new code and pick an AcuTech Mat Pro.
2. Back in the app, pull to refresh. Home shows **+₹322.81 on hold**: 12% of ₹2,690.10, the price after the student's 10% discount.
3. Tap the order in **Earnings** to see its timeline: placed, then "return window ends <date>", then ready, then paid.

## 3. The affiliate team keeps commissions honest (dashboard, about 1 minute)

1. Log in as **ops@partners.demo**. The **pipeline strip** at the top shows where all commission money is: on hold, needs review, ready, in payout, paid.
2. **Review → Needs review** lists three orders the system held back, each with a plain reason:
   - Rahul bought with his own code (self-referral)
   - a ₹21,520 bulk order from a studio (above the review limit)
   - one shopper using Meher's code four times in a month
3. Approve the studio order with a note ("Bulk order for their new batch, confirmed on call") and reject the self-referral. The rows leave the list and the strip updates.
4. Commissions that cleared the 15-day return window are released automatically by the release job. **Due for release** shows anything waiting.

> Why: commissions follow one state machine with guarded transitions and an embedded history, so "what happened to this money?" always has an answer.

## 4. Finance pays everyone on Friday (dashboard, about 1.5 minutes)

1. Log in as **finance@partners.demo** and open **Payouts**.
2. **Next payout (Fri)** lists everyone who will be paid, with gross, TDS (2% with PAN, 20% without) and net. **Can't be paid yet** explains everyone else:
   - Kabir has no payout details.
   - Several partners are below the ₹500 minimum.
   - Vikram is paused.
   - Ananya's clawback exceeds her balance.
3. Click **Create batch**. The commissions are locked into the batch, so they can't be paid twice. Click **Bank file (CSV)** to get the file for the bank's bulk upload.
4. Last Friday's batch, **PO-2026-W42**, is still being reconciled:
   - Record a **UTR** for one of the waiting payments.
   - Note that Dev's transfer bounced ("account closed"). His money went back to his balance automatically and appears in this Friday's run.

## 5. The partner sees the money land (app, 30 seconds)

1. Log in to the app as **priya@partners.demo**.
2. Open **Payouts**. Last Friday's payment shows commission, TDS and the amount sent, with a **Paid** stamp and the bank's UTR. **Home** shows what's ready for this Friday, after TDS.

That's the full loop: a code shared in class, an order, a commission that is held, checked, released and paid, and a partner who can see every step.
