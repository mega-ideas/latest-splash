# v2 Phase 3, brief 5.10: Phone

Dedicated phone layouts for Home, Transfer (one question per screen),
**Approve** (the approver's passkey sign screen, the most important phone
screen), Wallet and Zeke, and one rule for which device gets them. The
desktop layouts are unchanged; where a layout is a different screen on a
phone, the phone gets its own.

Code: `lib/device.ts`, `lib/dashboard/phone.ts`, `components/dashboard/`
(`Device`, `PhoneBar`, `PhoneTabBar`), `lib/approve/`, `components/approve/`,
`app/dashboard/approve/`, `lib/transfer/phone-steps.ts`,
`lib/transfer/bank-form.ts`, `components/transfer/PhoneTransfer.tsx`,
`components/home/`, `components/wallet/parts.tsx`, `lib/wallet-page/phone.ts`,
`components/oxwal/ZekePhone.tsx`, `lib/oxwal/phone-desk.ts`.

## Which device gets the phone layout

Two answers, one hook (`usePhone()` in `components/dashboard/Device.tsx`):

1. **The server's hint.** `app/dashboard/layout.tsx` reads the User-Agent
   (`phoneHintFromHeaders`, the same `isPhoneUserAgent` the landing page uses)
   and passes it to the shell as `phoneHint`. It makes the first byte the right
   layout. Phones are phones; tablets (an iPad's Macintosh UA, an Android tablet
   without "Mobile") keep the desktop layout.
2. **The window.** After that the width decides: `(max-width: 767px)`, the break
   the shell already uses for its rail (`md`). `useSyncExternalStore` renders the
   hint while React hydrates and the window's answer straight after, so there is
   no mismatch. A desktop window narrowed to a phone gets the phone layout; a
   phone turned sideways to a wide window gets the wide one.

Where only the look changes, CSS (`md:`) is still the tool. A component that is a
different screen on a phone asks `usePhone()` (Transfer, the sign screen, Home,
Wallet's sections, Zeke). `OnPhone` and `OffPhone` are the two wrappers.

## The frame

A bottom bar of five tabs, 56px tall, clear of the home indicator
(`viewport-fit=cover` and `env(safe-area-inset-bottom)`): Home, Transfer,
Approve, Wallet, Zeke. Everything else is one tap away in the menu, which still
holds the whole rail. The current tab is announced. Approve carries a badge with
how many wallet requests wait for this person's signature: their own inbox in
their own business, looked at every 30 seconds while the page is in view and at
once when a signature is given or declined; a failed read shows no badge, never
a made-up number. The floating Zeke is not drawn on a phone (Zeke is a tab, and
the widget covers the little content there is).

A screen with its own action bar (Transfer's Continue, Review's Approve, the
passkey button) draws it with `PhoneBar` and the tab bar steps aside, so there is
one bar at the foot, never two. `PhoneBar` is drawn in the body: the dashboard's
cards blur what is behind them (`backdrop-filter`), and a fixed element inside one
is fixed to the card, not the screen.

## Approve

`/dashboard/approve` lists what waits for this person's signature, each card
decoded on their own device. `/dashboard/approve/[id]` opens one, with the review
open at once, because the person came to sign.

What the screen shows is `approveFacts(review)`: **who is paid** (the address in
the bytes, in full and in groups of four, with a name only beside it, never
instead of it), **the amount**, **the asset** (USDC on Sui), **the Splash fee at
most**, **the rate** (a payment that is not in USDC: `1 USDC = 58.00 PHP` and what
that comes to, rounded down, before the partner's fee), what leaves the wallet at
most, and the **transaction code** to compare with the WhatsApp message. A batch
says how many payments and shows each; a change to the wallet is worded command by
command; a payment's own bookkeeping commands are one tap away, still on the
screen. A command the screen cannot word blocks signing.

All of it is a function of the device's own review (`reviewOnDevice`: the bytes
decoded on the person's device, the digest and hash recomputed and compared with
what the request claims). Bytes that do not match are not shown; the card says
they could not be checked and not to sign. `SignPanel` still signs the bytes that
were reviewed and checks them against what was approved on the Review step; the
phone changes how the review looks, not what is signed. The desktop review gains
the rate row.

One 56px "Sign with your passkey" button sits in a bar at the foot and is off
while a signature is in flight or when the screen cannot word part of the request.
"Not now" goes back. **Decline** (anyone but the person who asked) and
**Withdraw** (the person who asked) are one tap and a confirmation, through the
existing `DELETE /api/wallet/signing-requests/:id`. A request that is not in the
person's own business reads as absent, the same as one that does not exist.

Wallet's "Needs your signature" opens a request on this screen on a phone.

## Transfer, one question per screen

`lib/transfer/phone-steps.ts` is the order of the screens and what each needs
before Continue, as data. Only the questions that apply are asked:

| Payee | Questions |
|---|---|
| A business bank account | who, which supplier, amount, purpose, where the money comes from, reference, review. A new supplier: country, who holds it, name, company number (a business only), bank code, account number, town, relationship, check and save. Only an owner is asked these; anyone else is told whom to ask. |
| A business on Splash | who, which business, amount, reference, review |
| A Sui wallet address | who, where the USDC goes, amount, reference, review |

The five steps stay the unit the draft is kept by, so a draft kept from before
opens at the amount. **The phone sends nothing of its own.** State, the draft, the
quote, the fee bound, the intent id as the idempotency key and the signing are
`TransferFlow` and `StepReview`'s own, so walking back and forward never makes a
second payment. The bank form's checks and request (`bank-form.ts`, `bank-save.ts`),
the request for access (`PilotAccess`) and what the amount step knows
(`useAmountPlan`) are shared with the desktop rather than copied. A corridor that is
not live is a request for access, never a quote.

Every control the flow builds is 16px on a phone (`CONTROL` is `text-base
md:text-sm`), so the browser does not zoom the page in when a field is focused.
The question's heading takes focus when the screen changes; a screen that is one
text field takes focus itself.

## Home, Wallet, Zeke

- **Home** keeps its reads; `PhoneHome` takes them as props and fetches nothing.
  Balance first, the four actions as one row, "Needs your signature" before any
  history, this month's two figures side by side, payments as rows. The wallet
  card's words are `WalletBody`, shared with the desktop card.
- **Wallet**: what waits for a signature and the balance stay open, and Add funds,
  Withdraw and Send are three large targets under the balance. Every other section
  folds under its own title (`Card` in `parts.tsx`, native `details`), and a link to
  one (a hash in the address, or the balance's buttons) opens it.
- **Zeke**: the question and the composer first, the starters as a row to swipe,
  then what Zeke prepared lately; approvals, what Zeke can do and remembers, **What
  MemWal stores**, **quick links** and suggestions fold under titles, so none is
  dropped. A conversation fills the screen between the top bar and the tab bar with
  the composer under the thread.

## Tests

`phone-device` (the breakpoint, the hint and the window's answer, the tabs, the
badge, who is waiting), `phone-approve` (the facts as data, the passkey bar, the
pages, the words), `phone-approve-real` (a request made from real transaction
bytes: payee, amount, asset and fee bound read back from the bytes; bytes changed
after the digest are not shown; **another business's inbox and read are empty and
absent**; **a signature given twice is one signature and nothing is submitted
twice**), `phone-transfer` (the order of the questions, what each needs, the shared
bank form, **no second intent id**, the pilot corridor, owner-only questions),
`phone-pages` (the frame, Home, Wallet's folding and hash links, Zeke). The static
contrast audit (`dashboard-contrast`) covers every new component.

No new route reaches money. Production fails closed where it did before: the
phone reads the same routes, nothing here can show a sandbox result, a made-up
quote or a payout reference, and the sealed audit bundle is still made by the
server and refused under a demo policy in production
(`docs/v2/phase3-transfer.md`).

## Not done here

- **A real device.** The layouts were checked at 390x844 in a desktop browser with
  a phone User-Agent. The passkey prompt, the home indicator's inset and the
  on-screen keyboard are not exercised by that; they are Sky's on a phone.
- **A deep link from WhatsApp.** `/dashboard/approve/[id]` is the address; the
  WhatsApp message does not carry it yet (it names the transaction code).
- **Landscape phones** get the desktop layout (the window is wider than 767px).
- **Pages that are not these five** (Batch, Invoices, Treasury, Recipients, History,
  Settings, Setup, Support) keep their responsive desktop layouts on a phone, as the
  brief names five.
