import { ProfileView } from "../../../../components/ProfileView";

export default async function ProfilePage({
  params,
}: {
  params: Promise<{ chain: string; address: string }>;
}) {
  const { chain, address } = await params;
  return <ProfileView chain={decodeURIComponent(chain)} address={decodeURIComponent(address)} />;
}
