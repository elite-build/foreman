// The job prompts earlier Foreman builds wrote into a template employee's or the program manager's definition, before a
// definition recorded its job (`template`) and kept only its organization's additions (shared/employeePrompts): the
// SHA-256 of every text v1.2.0 to v1.2.3 and the builds after them made, each with plain line ends and trimmed, the
// read-only variants included. An employee whose prompt is one of these was never given anything of its own, so once
// per organization it is linked to its job's prompt instead (main/employees.ts) and improves when the job's prompt does.
import { createHash } from 'node:crypto'
import type { JobPromptId } from '../shared/employeePrompts'

const KNOWN: Record<JobPromptId, readonly string[]> = {
  'program-manager': [
    'd6a54faea66bee6a7f3df43f0a51d6d2b6a97cdb3926e8603b9df97d5c330250',
    '70645b1ec06646d4d2a1471da6dbbca774d29a6566b3624a8629a857b2d7829c',
    'd28b51fb02cdc58f453058d44e4d5cfa1778f110be99b042469548e1044bc8e1'
  ],
  'software-engineer': [
    '84e455c19274b278f14cd65cdb57f9dee4b9ee191abf14dfbcfbf2dc94bdf02d',
    '823d2e93d810333bcb1aad75067fad54e57401384cb01c9bfd1ed60fdf6aa0fd',
    'fe309cc12194c617cdd3c903b370a66f8fb1241b4cf27d76bd352849d036fea6'
  ],
  'frontend-engineer': [
    '34d1fd4124c1c12db2fb721ec54efd9a7dd1acece7d90b7460b8e09c3140dd7f',
    'f003b22b97b6cb15925f6fd0e2ae08ff363683401f731d25cefb1e86d3396148',
    '3c66864e187fa71793ad41250456dbad6e2cd5195b1550345897c8dd57690c25'
  ],
  'qa-engineer': [
    '94f285a043277f2ba2f83f51c4203ceeb0f0045b80be95e66fab429f60c03c1a',
    '8f5fcecd348c8f6d8a68b822fa608847406562688526a8b1fecd81e60448e4a0',
    '48313817e0ceb0badf028561f2e265c8cfc65d65b3122f16fffe0d3a6d51c8f7',
    'b6ac12c585a2f8f8f690cde502849e80942cd463d41aa20e64141b4741f681c7'
  ],
  'security-engineer': [
    '216e5194b2476d43e2f606dd11332a9234bb2a23869991d2fc93b55dc23c9f8b',
    '1b0892a9074e2dd2eade208eaaf91241a811d3aba66666326c6cc22faf158287',
    'f331173ced037c6fff85bbfe249aef3e822b304707aad5506cfea8a29faed8c2',
    '9847fb2a40e5be60a2169659b1a862c18ac573e43ddefca7915083c1f460490c'
  ],
  'site-reliability-engineer': [
    '14cc546c5f23b2c009888647610c740f6703037495627f1a98adbd193b4015c4',
    '8bf0516facabf274f746bbf6a9c87c29865dfd52711ba53ab7e4e2e8a5ed8f60',
    'a95799cb85a0d7b2695a712fd8a0c67d809855d89c082ce3aa00fbff0468de4c'
  ],
  'software-architect': [
    'e44f1c1aac04d2bcc08015c03162d81756cadaa33c0736990d455aea66f97e94',
    '0a46d05bbf7b05308ba6b9e0f2ef2eb51b244d76747e5842cad6cdf6fa497ccc',
    '2908bfcda6d69dc1cc5b3a90ebc19a1f3cb2cd255384d097b9b83b9d6ac051e3',
    '11916ecad33ae9cf4f64b412ecd8f482b132ef2b228684fb8a8548fd79255f16'
  ],
  'ux-designer': [
    '6ccd449107f45096189c6ddadc6a160cfe280633e4b725dfcc8f22995a1cc89e',
    'c6c8b1a2b9ebceb81d0ad12e9146cf6ee81511fd967e8f9d1d31c1118f4c54d6',
    'e5877cda7a39d9d60d93eb16b33186d47d4101848d51a22aed87a41fcba13572',
    '3dfac4de9038e978844abd8e44ff07daa45a4e6cf056a7b1959922a4d44eb61b'
  ],
  'web-designer': [
    '3b7cbbb1ed0c2adfdb5a7886d6ddc93e30331cff46c4cd3e18bd908365d1640f',
    '40098977b61b8aa266900fc98650630ef491ecf1abd5075c5c49bf7c8bf37a78',
    'b24333d773830120eac29aa58ef711292e0325242892b519974301625f82dd0e'
  ],
  'product-manager': [
    'ab1e56fe6d06d650ad2153f867a029c29f222e9b9fb44a840303c96daed0f3d9',
    '4a1a0afdecbd90364f8851f56f0e60ca6f5f1c17da5a33b4f8ff184792553742',
    '45410f415a93ba18343d8f0f702d411a109ca1453bbc5f02018ce35b67cdb463',
    'a6de792536c25052a117b55aadb4461c2f6b3c94f782cf348799266cb1236b97'
  ],
  'data-analyst': [
    '5c90a4bb7283a6ae4c5d97ca1f350590a47e9838372fabb8e90e95c99042f242',
    'c4c1a5b38ed981f95cd6f6f6173fe41c6e567e5eb8c9ae56b04df88eb488f056',
    '1a73ceb823de4fe1afee7cc69f6c7bdd5829517caf60ab729193697262972484',
    '62df68037c6f959c0c5a4e6dc4e3a6124cb7c65022a71807777ad916f3cec448'
  ],
  'technical-writer': [
    'a2ee16351d6f25682a67b5f2eaae433f6265d22136f9639aa42f57e2a58075e5',
    '71af038d4637bb5d9d8b6cb31d3e967d4736175b6e4207e97b343584516e979e',
    '0a38de592b5bd876b8ae899d375beb4e3473e021f5d9198cd87a36e0f20f3997'
  ],
  copywriter: [
    '5f67685629ef86a2b4fa4ecce97e9897527a69b60aca089f579f9a6dce5a3331',
    '148dd5e779ec62918637dc80697a1f6e82f13b9e7e647a4ed26529524cd743a8',
    '428cdac6ba639da6cdf8aa609aaa85fb267c7e0829a143463fefa760ae172f4f'
  ],
  'seo-specialist': [
    '9abc7baa02bf3852337f7f10e33eda8ea9b6073a3acf5f891c10eb3e7882b590',
    '27518b1071b42a2bdeb802529250facad4de526bb267906283e6bac910cc81f5',
    '535b432b20e63d2363cb312284d6b196a21b5932312fd10271ca6f19ed049226',
    '3c4aa70325ef0fb81308c1921f95d6c5227a411a6539f5b3844ff3da8d52012e'
  ],
  'marketing-manager': [
    '1cb611cd41de65fb0ff312ff4ea230dfd1491258a135931b3ba313dc4a2180df',
    'a68144f7768263a4d5d60fe4a19ea67a30a976e6d53d6fe925f49ae430f0a54f',
    '89ddf292b371715d63b5f987a89c7d13dd8cf6ff0c346c3568b7409bb96cdb5d',
    '4fb2f7179d6d50d15e9407922d81a9dde3a4a071f7921d8b61c5140e06402263'
  ],
  'support-engineer': [
    'd4bd9a4d861ca7cb2c5f6beba2b9da13a451c2054eb4934943192c5fc4aa2992',
    'c89b7d5a9052e5d3aaaebf702c795fc4efb4d18b0a333d1c76d670e0fbb57f50',
    '23795e156e649e4c904d524bb59557caee1881a26ae30306d2e269f937738ae2',
    'd82a1c0cfdc3dc85248b509045ee082881e2aca72b08069875c35a6dfe860716'
  ]
}

/** The job whose prompt, as an earlier build wrote it, `text` is word for word; null for any other text. */
export function jobOfEarlierPrompt(text: string): JobPromptId | null {
  const hash = createHash('sha256').update(text.replace(/\r\n?/g, '\n').trim()).digest('hex')
  for (const [job, hashes] of Object.entries(KNOWN) as [JobPromptId, readonly string[]][]) if (hashes.includes(hash)) return job
  return null
}
