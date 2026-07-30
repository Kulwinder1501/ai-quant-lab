import { GlassPanel } from "../../../components/ui/glass-panel";

interface CreateAccountModalProps {
  show: boolean;
  onClose: () => void;
  onSubmit: (e: React.FormEvent) => void;
  newAccountName: string;
  setNewAccountName: (val: string) => void;
  newAccountBalance: number;
  setNewAccountBalance: (val: number) => void;
  createError: string | null;
}

export function CreateAccountModal({
  show,
  onClose,
  onSubmit,
  newAccountName,
  setNewAccountName,
  newAccountBalance,
  setNewAccountBalance,
  createError
}: CreateAccountModalProps) {
  if (!show) return null;
  
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <GlassPanel className="w-full max-w-md p-6 border-cyan-500/30 bg-slate-950 shadow-2xl">
        <h3 className="text-xl font-bold text-white">Create Paper Portfolio</h3>
        <p className="text-xs text-slate-400 mt-1">Set an opening capital balance in INR for quantitative strategy simulations.</p>
        {createError && <p className="mt-3 text-xs text-rose-400 bg-rose-500/10 p-2 rounded border border-rose-500/20">{createError}</p>}
        <form onSubmit={onSubmit} className="mt-4 space-y-4">
          <div>
            <label className="block text-xs font-semibold text-slate-300 uppercase">Portfolio Name</label>
            <input
              type="text"
              required
              value={newAccountName}
              onChange={(e) => setNewAccountName(e.target.value)}
              className="mt-1 w-full rounded-xl bg-slate-900 border border-white/10 px-3.5 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-cyan-400"
              placeholder="e.g. Breakout Alpha Fund"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-300 uppercase">Opening Capital (₹ INR)</label>
            <input
              type="number"
              required
              min="1000"
              step="1000"
              value={newAccountBalance}
              onChange={(e) => setNewAccountBalance(Number(e.target.value))}
              className="mt-1 w-full rounded-xl bg-slate-900 border border-white/10 px-3.5 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-cyan-400"
            />
          </div>
          <div className="flex items-center justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-xl text-sm font-semibold text-slate-400 hover:text-white transition"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-5 py-2 rounded-xl text-sm font-semibold text-white bg-cyan-600 hover:bg-cyan-500 transition shadow-lg shadow-cyan-500/20"
            >
              Create Fund
            </button>
          </div>
        </form>
      </GlassPanel>
    </div>
  );
}
