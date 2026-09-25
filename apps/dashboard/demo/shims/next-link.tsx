import type { AnchorHTMLAttributes, ReactNode } from "react";

/** next/link replacement: "/portfolio" → "#portfolio" (only bare #tokens are allowed by the host). */
export default function Link({ href, children, ...rest }: { href: string; children: ReactNode } & AnchorHTMLAttributes<HTMLAnchorElement>) {
  const token = href.replace(/^\//, "");
  return (
    <a href={token ? `#${token}` : "#radar"} {...rest}>
      {children}
    </a>
  );
}
