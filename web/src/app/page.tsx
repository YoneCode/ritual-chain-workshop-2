import { ConnectBar } from "@/components/ConnectBar";
import { CreateMarket } from "@/components/CreateMarket";
import { MarketBoard } from "@/components/MarketBoard";

export default function Home() {
  return (
    <main className="wrap">
      <header className="top">
        <div>
          <h1>Ritual Predict</h1>
          <p>
            Binary prediction markets that settle themselves. Betting closes at a block, the
            Ritual Scheduler wakes the contract at a block, and the contract reads its oracle
            through the HTTP and jq precompiles. No resolve button exists.
          </p>
        </div>
        <ConnectBar />
      </header>

      <CreateMarket />
      <MarketBoard />

      <footer className="foot">
        Every deadline here is a block number, not a timestamp — on Ritual Chain{" "}
        <code>block.timestamp</code> is in milliseconds, and the Scheduler fires at a block, so
        the contract never reads a clock. Payouts are pari-mutuel and pull-based:{" "}
        <code>stake × totalPool ÷ winningPool</code>.
      </footer>
    </main>
  );
}
