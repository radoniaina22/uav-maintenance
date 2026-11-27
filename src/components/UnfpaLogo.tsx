/**
 * Logo UNFPA des documents imprimés (CRM, rapport WindPath, carnet de vol, historique technique,
 * ordre de travail, étiquettes). PNG : rendu fidèle par html2canvas lors de l'export PDF.
 */
export default function UnfpaLogo({ className }: { className?: string }) {
  return <img src="./logo-unfpa.png" width={1294} height={610} alt="UNFPA" className={`unfpa-logo${className ? ` ${className}` : ''}`} />;
}
