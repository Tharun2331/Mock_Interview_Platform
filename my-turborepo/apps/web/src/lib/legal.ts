// The Privacy Policy and Terms of Service, as data.
//
// Kept apart from messages.ts because these are documents, not interface
// strings: they change together, on a date, and the date is part of the
// content. Rendered by components/LegalDocument.tsx.
//
// Every factual claim in the privacy policy is a claim about the code, and a
// policy that says something the system does not do is the policy that gets
// someone sued. The sources, so the next change to either side can be checked
// against the other:
//
//   What is stored          docs/architecture/data-model.md
//   Resume redaction        apps/servers/lib/redact.ts
//   Audio is not kept       data-model.md §3, "There is no audio/ prefix"
//   Account erasure         apps/servers/lib/erasure.ts
//   Log retention (30 d)    modules/cloudwatch, var.log_retention_days
//   Backups (35 d)          modules/dynamodb, point_in_time_recovery
//   Region                  us-east-1
//
// Change one of those and this file changes in the same commit, with
// EFFECTIVE_DATE moved forward.

// ---- Fill these in before launch -------------------------------------------
//
// The operator must be a real, identifiable person or company, and the contact
// address must be one somebody reads: privacy laws (PIPEDA in Canada, the GDPR
// in the EU) require a named party who answers access and deletion requests.
//
// OPERATOR is still a placeholder, not a confirmed value; replace it before
// this ships. CONTACT_EMAIL is the operator's personal inbox until a
// dedicated privacy address exists on the product's own domain.
export const LEGAL = {
  OPERATOR: "Tharun Sekar",
  CONTACT_EMAIL: "tharunsd23@gmail.com",
  JURISDICTION: "the Province of Ontario, Canada",
  MINIMUM_AGE: 16,
  EFFECTIVE_DATE: "October 1, 2026",
  LIABILITY_CAP: "CAD $50",
} as const;

export type LegalBlock =
  | { kind: "p"; text: string }
  | { kind: "list"; items: readonly string[] }
  | {
      kind: "table";
      caption: string;
      head: readonly [string, string, string];
      rows: readonly (readonly [string, string, string])[];
    }
  | { kind: "contact" };

export type LegalSection = {
  // Becomes the heading's id, so a section can be linked to directly —
  // /privacy#collect is what the sign-up notice points at.
  id: string;
  title: string;
  blocks: readonly LegalBlock[];
};

export type LegalDoc = {
  title: string;
  summary: string;
  sections: readonly LegalSection[];
};

const P = (text: string): LegalBlock => ({ kind: "p", text });
const LIST = (...items: string[]): LegalBlock => ({ kind: "list", items });

export const PRIVACY_POLICY: LegalDoc = {
  title: "Privacy Policy",
  summary:
    "What PrepPilot collects, why, where it is kept, who else handles it, and how to have it removed. We do not sell your data, show ads, or use your interviews to train AI models.",
  sections: [
    {
      id: "who",
      title: "Who we are",
      blocks: [
        P(
          `PrepPilot is a mock interview practice service operated by ${LEGAL.OPERATOR} ("we", "us"). We are responsible for the personal information described here. Questions or requests go to ${LEGAL.CONTACT_EMAIL}.`,
        ),
      ],
    },
    {
      id: "collect",
      title: "What we collect and why",
      blocks: [
        P(
          "We collect only what the practice interview needs. The table lists every kind of information we keep, what it is used for, and how long it stays.",
        ),
        {
          kind: "table",
          caption: "Information PrepPilot keeps",
          head: ["Information", "Why we need it", "How long we keep it"],
          rows: [
            [
              "Account: your email address, and your password if you sign up with one. If you sign in with Google, the email and name Google shares with us. Your two-factor settings, if you turn them on.",
              "To create your account, sign you in, and send verification codes. Passwords are held by our sign-in provider as a one-way hash; we never see them.",
              "Until you delete your account.",
            ],
            [
              "Profile: username, first and last name, and GitHub username.",
              "To address you and to find your public repositories.",
              "Until you change them or delete your account.",
            ],
            [
              "Resume: the PDF you upload, and the text extracted from it.",
              "To plan questions around your experience. Before any AI model sees your resume, names, contact details and identity numbers are automatically removed from the text. The original PDF is stored privately and unchanged so you can replace or re-process it.",
              "Until you upload a new one (which replaces it) or delete your account.",
            ],
            [
              "Public GitHub repositories: names, descriptions and star counts of the public repositories under the username you give us.",
              "To ask about your own projects. We never ask you to sign in to GitHub and cannot see private repositories.",
              "Until you change your GitHub username or delete your account.",
            ],
            [
              "Interview content: the role you are practising for, any company name and notes you give us, the interview plan, the questions asked, a text transcript of your spoken answers, answer timings, scores, written feedback and your coaching plan.",
              "To run the interview, score your answers, coach you, and show your progress over time in your history.",
              "Until you delete your account.",
            ],
            [
              "Your voice, during an interview.",
              "Streamed live to the speech model so the interviewer can hear and respond to you. Only the text transcript is kept.",
              "Not stored. The audio is discarded as the interview runs.",
            ],
            [
              "Usage counts: how many interviews you have conducted and how many AI requests your account has made today.",
              "To enforce free-tier limits and protect the service from abuse.",
              "Until you delete your account.",
            ],
            [
              "Technical logs: IP address, request times, and error details.",
              "To keep the service secure, limit request rates, and fix problems.",
              "30 days.",
            ],
          ],
        },
        P(
          "We do not ask for, and you should not upload, sensitive information such as government ID numbers, health information, or financial account details. If a resume contains them by mistake, our automatic redaction removes common identifiers from the text, but the original PDF is kept as uploaded.",
        ),
      ],
    },
    {
      id: "ai",
      title: "How AI is used",
      blocks: [
        P(
          "Interviews, scoring and coaching are produced by AI models. Your redacted resume text, public repository details, interview transcript and the notes you give us are sent to these models to generate questions, evaluate answers and write feedback.",
        ),
        P(
          "The models run on Amazon Bedrock, a service of Amazon Web Services. Under AWS's terms, what we send is not used to train the models and is not shared with the companies that build them. We do not use your interviews to train AI models of our own.",
        ),
        P(
          "Scores and feedback are generated automatically and can be wrong. No decision with legal or similar effect on you is made by them: they are practice feedback for you alone and are never shared with employers.",
        ),
      ],
    },
    {
      id: "sharing",
      title: "Who else handles your information",
      blocks: [
        P(
          "We do not sell or rent your personal information, and we do not share it with advertisers or employers. It is handled only by the service providers that run PrepPilot on our behalf, under contracts that limit them to doing so:",
        ),
        LIST(
          "Amazon Web Services: hosting, storage, sign-in and verification email (Amazon Cognito), AI models (Amazon Bedrock), and automatic detection of personal details in resumes (Amazon Comprehend).",
          "Google, only if you choose to sign in with Google.",
          "GitHub, which receives our request for the public repositories of the username you give us.",
        ),
        P(
          "We may also disclose information if the law requires it, to protect the safety or rights of users or others, or as part of a sale or reorganisation of the service, in which case this policy continues to apply to it.",
        ),
      ],
    },
    {
      id: "where",
      title: "Where your information is stored",
      blocks: [
        P(
          "Your information is stored and processed in the United States (AWS's us-east-1 region). If you live elsewhere, including in Canada or the EU, it may be accessible to courts and authorities there under local law. By using PrepPilot you understand that your information is transferred there.",
        ),
      ],
    },
    {
      id: "browser",
      title: "Cookies and browser storage",
      blocks: [
        P(
          "PrepPilot uses your browser's local storage to keep you signed in and to remember your light or dark theme. These are necessary for the service to work. We do not use advertising cookies, analytics trackers, or third-party tracking of any kind.",
        ),
      ],
    },
    {
      id: "security",
      title: "How we protect it",
      blocks: [
        P(
          "Information is encrypted in transit and at rest. Uploaded resumes sit in private storage that is never reachable from the internet. Each account can reach only its own data, and you can turn on two-factor authentication under Profile. No system is perfectly secure; if a breach affects your information we will notify you and the relevant authorities as the law requires.",
        ),
      ],
    },
    {
      id: "rights",
      title: "Your choices and rights",
      blocks: [
        P("Depending on where you live, you have the right to:"),
        LIST(
          "See the personal information we hold about you and get a copy of it.",
          "Correct information that is wrong. You can edit your profile and replace your resume yourself at any time.",
          "Delete your account and everything in it. Use Delete account under Profile; it takes effect immediately.",
          "Withdraw your consent, by deleting your account. We cannot run interviews without the information above.",
          "Complain to a privacy regulator, such as the Office of the Privacy Commissioner of Canada or the data protection authority where you live.",
        ),
        P(
          `For anything you cannot do yourself in the app, email ${LEGAL.CONTACT_EMAIL}. We will answer within 30 days and may ask you to confirm your identity first.`,
        ),
        P(
          "When you delete your account we erase your profile, resume, interviews and sign-in identity right away. Copies can remain in encrypted backups for up to 35 days and in technical logs for up to 30 days, after which they are overwritten.",
        ),
      ],
    },
    {
      id: "children",
      title: "Age limit",
      blocks: [
        P(
          `PrepPilot is not meant for anyone under ${LEGAL.MINIMUM_AGE}. We do not knowingly collect information from children. If you believe a child has created an account, contact us and we will delete it.`,
        ),
      ],
    },
    {
      id: "changes",
      title: "Changes to this policy",
      blocks: [
        P(
          "If we change this policy, we will update the date at the top. If the change is significant, for example a new use of your information, we will tell you by email or in the app before it takes effect.",
        ),
      ],
    },
    {
      id: "contact",
      title: "Contact",
      blocks: [{ kind: "contact" }],
    },
  ],
};

export const TERMS_OF_SERVICE: LegalDoc = {
  title: "Terms of Service",
  summary:
    "The agreement between you and PrepPilot. The parts most worth reading: AI feedback can be wrong and is not career advice, do not share anything you are bound to keep confidential, and the service is provided as is.",
  sections: [
    {
      id: "agreement",
      title: "Agreement",
      blocks: [
        P(
          `These terms are an agreement between you and ${LEGAL.OPERATOR}, who operates PrepPilot ("we", "us"). By creating an account or using PrepPilot, you agree to them and to our Privacy Policy. If you do not agree, do not use the service.`,
        ),
      ],
    },
    {
      id: "eligibility",
      title: "Who can use PrepPilot",
      blocks: [
        P(
          `You must be at least ${LEGAL.MINIMUM_AGE} years old and able to agree to these terms. You may have one account, for yourself, and the information you give us must be accurate. You are responsible for keeping your sign-in details secure and for everything done through your account. Tell us right away if you think someone else has accessed it.`,
        ),
      ],
    },
    {
      id: "service",
      title: "What PrepPilot is, and is not",
      blocks: [
        P(
          "PrepPilot is a practice tool. It runs simulated interviews with an AI interviewer and gives AI-generated scores and feedback.",
        ),
        LIST(
          "AI output can be inaccurate, incomplete, or inconsistent. Questions may not match what any real employer asks, and two runs of the same answer can score differently.",
          "Feedback is for practice only. It is not career, legal, or professional advice, and it is not an assessment by, or on behalf of, any employer.",
          "We do not promise that using PrepPilot will get you an interview, an offer, or a job.",
          "Company-specific preparation reflects only the notes you give us. We have no relationship with, and are not endorsed by, any company you name.",
        ),
      ],
    },
    {
      id: "content",
      title: "Your content",
      blocks: [
        P(
          "Your resume, notes, answers and transcripts remain yours. You give us a limited licence to store, copy and process them only as needed to provide PrepPilot to you, including sending them to our service providers as described in the Privacy Policy. That licence ends when you delete the content or your account, apart from backup copies that expire on the schedule the Privacy Policy describes.",
        ),
        P("You promise that:"),
        LIST(
          "You have the right to upload what you upload.",
          "You will not share confidential information belonging to anyone else, including a current or former employer's trade secrets, source code, or customer data, or real interview questions you agreed to keep confidential.",
          "You will not include other people's personal information beyond what normally appears on a resume.",
        ),
      ],
    },
    {
      id: "use",
      title: "Acceptable use",
      blocks: [
        P("You agree not to:"),
        LIST(
          "Use PrepPilot to get live help during a real interview or assessment, or to misrepresent your abilities to an employer.",
          "Access the service with bots, scripts, or other automated means, or scrape it.",
          "Get around usage limits, for example by creating extra accounts.",
          "Try to break, probe, or overload the service, its security, or other users' accounts, or reverse engineer it except where the law allows.",
          "Try to make the AI produce content that is unlawful, harassing, hateful, or sexually explicit, or to reveal its instructions.",
          "Upload malware, or use PrepPilot for anything unlawful.",
        ),
      ],
    },
    {
      id: "limits",
      title: "Usage limits and fees",
      blocks: [
        P(
          "PrepPilot is currently free, with limits on how many interviews and AI requests each account can use. We may change these limits. If we ever charge for PrepPilot, we will tell you the price before you are asked to pay, and nothing will be charged without your agreement.",
        ),
      ],
    },
    {
      id: "ours",
      title: "Our property",
      blocks: [
        P(
          "PrepPilot, including its software, design, name, and the questions and feedback it produces, belongs to us, apart from your own content. You may use the feedback generated for you for your own preparation. If you send us suggestions, we may use them without owing you anything.",
        ),
      ],
    },
    {
      id: "third-party",
      title: "Other services",
      blocks: [
        P(
          "PrepPilot relies on services run by others, such as Google sign-in and GitHub. Their own terms govern your use of them, and we are not responsible for them.",
        ),
      ],
    },
    {
      id: "termination",
      title: "Suspension and ending your account",
      blocks: [
        P(
          "You can stop using PrepPilot and delete your account at any time from your Profile. We may suspend or close an account that breaks these terms or puts the service or other users at risk, and we may change or discontinue PrepPilot. Where we reasonably can, we will give notice so you can view your feedback first. Sections that by their nature should continue, such as disclaimers, limits on liability and governing law, survive the end of this agreement.",
        ),
      ],
    },
    {
      id: "disclaimer",
      title: "Disclaimer",
      blocks: [
        P(
          'PrepPilot is provided "as is" and "as available". To the fullest extent the law allows, we make no warranties of any kind, express or implied, including that the service will be uninterrupted, error-free, or secure, that its output will be accurate, or that it is fit for any particular purpose.',
        ),
      ],
    },
    {
      id: "liability",
      title: "Limitation of liability",
      blocks: [
        P(
          "To the fullest extent the law allows, we are not liable for any indirect, incidental, special, consequential or punitive damages, or for lost opportunities, employment, income, data, or goodwill, arising from your use of PrepPilot or reliance on its output, even if we were told they were possible.",
        ),
        P(
          `Our total liability for any claim relating to PrepPilot is limited to the greater of the amount you paid us in the 12 months before the claim and ${LEGAL.LIABILITY_CAP}.`,
        ),
        P(
          "Some places do not allow these exclusions or limits, so some of them may not apply to you. Nothing in these terms limits rights you have as a consumer that cannot be limited by contract.",
        ),
      ],
    },
    {
      id: "indemnity",
      title: "Indemnity",
      blocks: [
        P(
          "If someone makes a claim against us because of content you uploaded or because you broke these terms, you agree to cover our reasonable losses and costs from that claim, to the extent the law allows.",
        ),
      ],
    },
    {
      id: "law",
      title: "Governing law",
      blocks: [
        P(
          `These terms are governed by the laws of ${LEGAL.JURISDICTION}, and the federal laws of Canada that apply there. Any dispute will be heard by the courts located in Ontario, unless the consumer law where you live gives you the right to bring it at home.`,
        ),
      ],
    },
    {
      id: "changes",
      title: "Changes to these terms",
      blocks: [
        P(
          "We may update these terms. We will change the date at the top and, for significant changes, tell you by email or in the app before they take effect. Continuing to use PrepPilot after that means you accept the new terms.",
        ),
      ],
    },
    {
      id: "general",
      title: "General",
      blocks: [
        P(
          "These terms and the Privacy Policy are the whole agreement between us about PrepPilot. If any part is found unenforceable, the rest still applies. Not enforcing a term is not a waiver of it. You may not transfer this agreement; we may transfer it as part of a sale or reorganisation of the service.",
        ),
      ],
    },
    {
      id: "contact",
      title: "Contact",
      blocks: [{ kind: "contact" }],
    },
  ],
};
