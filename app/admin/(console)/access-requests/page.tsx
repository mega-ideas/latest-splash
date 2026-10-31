import { PILOT_ROUTES } from '@/lib/landing/routes';
import { listAccessRequestsForStaff } from '@/lib/server/access-requests';

export const dynamic = 'force-dynamic';

const countryOf = (currency: string) => PILOT_ROUTES.find((r) => r.currency === currency)?.country ?? currency;

const when = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kuala_Lumpur' });

/**
 * Requests for pilot access from the landing calculator (v2 brief D16):
 * a business asking for payouts to MYR, VND, THB or SGD. Staff only: the
 * console layout requires the staff session, and this is the only page
 * that reads the requests (lib/server/access-requests.ts). The same list
 * downloads as JSON from /api/admin/access-requests.
 */
export default async function AdminAccessRequestsPage() {
  const requests = await listAccessRequestsForStaff();

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-3xl font-black tracking-[-0.03em] text-[#1f4350]">Pilot access requests</h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-[#326273]">
          Businesses that asked, from the landing page, for payouts on a route under pilot access. One row per
          email and route; asking again does not add a row. Newest first, times in Kuala Lumpur.
        </p>
      </header>

      {requests.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-[#326273]/25 bg-white p-6 text-sm text-[#326273]">
          No requests yet. They appear here when someone picks MYR, VND, THB or SGD in the landing calculator and asks for access.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-[#326273]/10 bg-white shadow-sm">
          <table className="w-full min-w-[640px] text-left text-sm text-[#1f4350]">
            <caption className="sr-only">Pilot access requests, newest first</caption>
            <thead className="border-b border-[#326273]/10 text-[12px] font-bold uppercase tracking-[0.08em] text-[#326273]">
              <tr>
                <th scope="col" className="px-4 py-3">Received</th>
                <th scope="col" className="px-4 py-3">Company</th>
                <th scope="col" className="px-4 py-3">Work email</th>
                <th scope="col" className="px-4 py-3">Route</th>
              </tr>
            </thead>
            <tbody>
              {requests.map((request) => (
                <tr key={request.id} className="border-t border-[#326273]/5 first:border-t-0">
                  <td className="whitespace-nowrap px-4 py-3 tabular-nums">{when.format(new Date(request.createdAt))}</td>
                  <td className="px-4 py-3 font-semibold">{request.company}</td>
                  <td className="px-4 py-3">
                    <a className="font-semibold text-[#237284] underline-offset-2 hover:underline" href={`mailto:${request.email}`}>
                      {request.email}
                    </a>
                  </td>
                  <td className="whitespace-nowrap px-4 py-3">{request.currency}, {countryOf(request.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
