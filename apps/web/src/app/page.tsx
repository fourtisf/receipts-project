export default function Home() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-24">
      <h1 className="text-5xl font-bold tracking-tight">{process.env.NEXT_PUBLIC_APP_NAME ?? 'Receipts'}</h1>
      <p className="mt-4 text-muted">Scaffold running. Screens land in M3.</p>
    </main>
  );
}
