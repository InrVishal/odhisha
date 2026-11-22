import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { site } from "@/content/site";

export default function MarketingLayout({ children }: LayoutProps<"/">) {
  return (
    <>
      <p className="bg-navy px-4 py-2 text-center text-sm text-lavender">{site.demoBanner}</p>
      <SiteHeader />
      {children}
      <SiteFooter />
    </>
  );
}
