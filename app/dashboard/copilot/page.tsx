import { redirect } from 'next/navigation';

/**
 * The copilot room folded into the Zeke page (v2 brief 5.1): one Zeke, at
 * /dashboard/zeke. Its suggestions moved with it
 * (components/oxwal/ZekeSuggestions.tsx). Keep old deep links working.
 */
export default function CopilotPage() {
  redirect('/dashboard/zeke');
}
