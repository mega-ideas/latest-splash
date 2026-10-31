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
their own business, asked of `GET /api/wallet/signing-requests/count` (a count and
no transaction bytes) every 30 seconds while the page is in view and at once when a
signature is given or declined. A look that fails keeps the last count read, never
a made-up number, and a 401, 403 or 404 stops the asking (`readWaiting`). The
floating Zeke is not drawn on a phone (Zeke is a tab, and
the widget covers the little content there is).

A screen with its own action bar (Transfer's Continue, Review's Approve, the
passkey button) draws it with `PhoneBar` and the tab bar steps aside, so there is
one bar at the foot, never two. `PhoneBar` is drawn in the body: the dashboard's
cards blur what is behind them (`backdrop-filter`), and a fixed element inside one
is fixed to the card, not the screen. Being outside the page, it is not drawn (and
so is inert) while the menu drawer is open, or it would cover the foot of the menu.

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

**Nothing hides behind a payment's headline.** The decoder accepts a send to
another address in any wallet transaction, so a request that reads as "Pay 250.00
USDC" could carry a second payout. A payment or a batch may contain only a
payment's own bookkeeping (coins gathered, the receipt, the cleanup); any other
step is `unexpected`: the steps open under "Also in this transaction", the line
is marked, and the request is **blocked**. What leaves the wallet must be exactly
each payment plus the most its fee may be; more (another withdrawal) or less is
blocked with the two figures. A payment opened without being paid here, or paid
without being opened, is blocked. A target currency that is not a three-letter
code, or a rate of nothing on a payment not in dollars, is blocked ("the rate
cannot be shown") and never throws: `approveFacts` as a whole never throws, so the
sign screen says do not sign and the person can still decline from the same page.
The reason is the first thing on the screen, above the amount, and the same words
are on the inbox card (`cardSummary`: a blocked request says do not sign; a change
says its first line and how many more). The sign function repeats the check where
the signing is. The fee bound and the rate are in the first screenful, and the
transaction code sits beside the passkey button.

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
**Withdraw** (the person who asked, also after signing) are one tap and a
confirmation, through the existing `DELETE /api/wallet/signing-requests/:id`; a
decline that leaves the request unable to reach its threshold is told it closed
(`closeOutcomeText`). A request that is not in the person's own business reads as
absent, the same as one that does not exist.

Wallet's "Needs your signature" opens a request on this screen on a phone.

### The link in the signing message

Sky's decision: the WhatsApp signing message links to `/dashboard/approve/[id]`
(`lib/approve/link.ts`, worded in `walletSignatureMessage`, sent by
`walletSigningNotifier`).

```
Review it here: https://<the business's own address>/dashboard/approve/wsr_...
The link only opens the review. It signs nothing and carries no secret; nothing
happens until you sign with your passkey.
On the screen, check the payee, the amount and the fee, and that the transaction
code is 1a2b 3c4d 5e6f 7a8b. This request expires in 24 hours.
```

What the link is:

- **No secret, nothing signed.** The address is the origin of `NEXT_PUBLIC_APP_URL`
  (any path, query, fragment or credentials in it are cut) plus the request's id.
  The id is an identifier, not a credential: reading the request takes the
  person's own session and business, and a request that is not theirs reads as
  absent, the same as one that does not exist. No query string, no token, no
  transaction bytes. The WhatsApp message still carries no payee's bank details.
- **Opening it only shows the screen.** The page reads the request once
  (`GET /api/wallet/signing-requests/:id`) and decodes the bytes on the device:
  payee, amount, asset and fee bound, from the exact bytes. Nothing executes until
  an approver signs with their own passkey; the page itself sends only the
  confirmed decline or withdraw.
- **The transaction code is still the second check.** The message names it, the
  screen shows it above the passkey button and beside it ("If your WhatsApp message
  shows a different code, do not sign. Opening this page from a link signs nothing;
  only your passkey does."). The link does not replace the comparison.
- **Fails closed.** In production a link is made only on https and never for a
  local address; with no usable address the message goes without a link and says
  "Open Splash, check the details and the transaction code ..." as before. A
  plain-http link is never sent in production. The inbox in the app is the channel
  that always works.
- **Signed out.** The dashboard layout sends a signed-out visitor to
  `/login?next=<that one address>` and the password sign-in returns to it. The way
  back is an allowlist of one shape, `/dashboard/approve/<id>` exactly
  (`safeApproveReturn`): another site, another path, a query, a fragment, a doubled
  slash or a dot segment signs in to Home. The proxy sets the header the layout
  reads (`x-splash-return`) from the path alone and drops whatever the browser sent
  under that name. zkLogin keeps landing on Home.

**No approval, no draw.** A payment that needs the owners cannot execute without
their recorded signatures, whatever is opened or replayed: tested at the service
level in `approve-link-service` (no signature, one of two, the same owner twice, a
read of the link any number of times, a signature after execution: the chain sees
no submission before the quorum and one after; a staff payment is an ask that
approves only when its request executes; another business's request and a member
who is not a signer read as absent and sign nothing).

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

Once the request is made there is no Back and no "Question n of m": the draft
cannot be edited under a request that is out for signature, and Back is off while
the request is being sent. The request is held by `TransferFlow`, above the phone
and desktop layouts, so a window moved across the phone break mid-send still
receives it.

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
absent**; **a signature given twice is refused (409, already signed), no second
signature is stored and nothing is submitted twice**; **a payment with a second
payout added to its real bytes is blocked and named**; a bank payout's rate, a
currency that is not a code and a rate of nothing are read from real bytes),
`approve-link` (the link, its production fail-closed rule, the way back after
sign-in, the message and the notifier, one place wording the message) and
`approve-link-service` (no approval, no draw, cross-tenant, replay),
`phone-transfer` (the order of the questions, what each needs, the shared
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
- **An ask to the owners has no link.** A payment a staff member asked the owners
  to approve is an ask, not a request to sign: there is nothing to open on the
  Approve screen until an owner accepts it, and then the signing message (with its
  link) goes to the owners. The ask's own message still says "Open Splash to review
  it. Nothing is paid until the owners sign."
- **No email or push for a signing request exists.** WhatsApp and the inbox are
  the two channels. If one is added it must build its text with
  `walletSignatureMessage` (a test fails if any other file words the message), so
  the link, what it signs and the code check read the same.
- **Keyboard and viewport on a phone.** The Zeke composer's height uses `dvh`,
  which on iOS does not shrink for the on-screen keyboard, and `viewport-fit=cover`
  is set for the whole dashboard. Neither can be exercised without a phone.
- **Landscape phones** get the desktop layout (the window is wider than 767px).
- **Pages that are not these five** (Batch, Invoices, Treasury, Recipients, History,
  Settings, Setup, Support) keep their responsive desktop layouts on a phone, as the
  brief names five.
