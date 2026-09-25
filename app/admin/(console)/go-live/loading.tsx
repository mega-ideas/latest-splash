/** The checks call DeepBook, Ethereum, Sui and Twilio; they take a few seconds. */
export default function GoLiveLoading() {
  return (
    <div className="mx-auto max-w-7xl space-y-6" aria-busy="true">
      <header className="dash-surface p-6 md:p-8">
        <span className="dash-kicker">Go-live</span>
        <h1 className="dash-title mt-2 text-4xl">Is this server ready to move real money?</h1>
        <p className="mt-3 text-sm text-[#326273]/70" role="status">Running the checks: prices, the mainnet node, Twilio and screening take a few seconds.</p>
      </header>
      {[7, 5].map((rows, section) => (
        <div key={section} className="dash-surface p-5 md:p-6" aria-hidden="true">
          <div className="h-5 w-48 rounded bg-[#326273]/10" />
          {Array.from({ length: rows }, (_, i) => (
            <div key={i} className="mt-4 h-10 rounded-xl bg-[#326273]/[0.06]" />
          ))}
        </div>
      ))}
    </div>
  );
}
