/**
 * `@raptor/ui` public surface.
 *
 * DESIGN SYSTEM — see ../DESIGN.md for the rationale behind every token, and
 * src/styles/tokens.css for the values themselves.
 *
 * The whole point of this barrel is that it is SHORT. Every export here is a
 * primitive whose accessibility has a test next to it. A component that is
 * not exported is a component nobody can adopt accidentally.
 */

export { Badge, badgeVariants, type BadgeProps } from "./components/badge";
export { Alert, alertVariants, type AlertProps } from "./components/alert";
export { Button, buttonVariants, type ButtonProps } from "./components/button";
export {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  type CardProps,
} from "./components/card";
export { Main, PageFooter, PageHeader, SkipLink, Stat, type PageHeaderProps, type SkipLinkProps } from "./components/app-shell";
export { PrimaryNav, type NavItem, type PrimaryNavProps } from "./components/primary-nav";
export {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
  TableRowHeader,
  type TableProps,
} from "./components/table";
export { TextField, type TextFieldProps } from "./components/text-field";

export { cn } from "./lib/cn";

export {
  DARK_THEME,
  LIGHT_THEME,
  THEMES,
  type ContrastRequirement,
  type ThemeTokens,
} from "./tokens";