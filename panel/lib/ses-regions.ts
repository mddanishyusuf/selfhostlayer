// The regions where Amazon SES's API runs, grouped as the AWS console groups
// them (docs.aws.amazon.com/general/latest/gr/ses.html, as of 2026-11-01).
// A region added later can still be typed in: the form has "Another region".
export const SES_REGIONS: [group: string, regions: [code: string, name: string][]][] = [
  ["United States", [["us-east-1", "US East (N. Virginia)"], ["us-east-2", "US East (Ohio)"], ["us-west-1", "US West (N. California)"], ["us-west-2", "US West (Oregon)"]]],
  ["Canada", [["ca-central-1", "Canada (Central)"], ["ca-west-1", "Canada West (Calgary)"]]],
  ["South America", [["sa-east-1", "South America (São Paulo)"]]],
  [
    "Europe",
    [["eu-west-1", "Europe (Ireland)"], ["eu-west-2", "Europe (London)"], ["eu-west-3", "Europe (Paris)"], ["eu-central-1", "Europe (Frankfurt)"], ["eu-central-2", "Europe (Zurich)"], ["eu-north-1", "Europe (Stockholm)"], ["eu-south-1", "Europe (Milan)"]],
  ],
  [
    "Asia Pacific",
    [
      ["ap-south-1", "Asia Pacific (Mumbai)"],
      ["ap-south-2", "Asia Pacific (Hyderabad)"],
      ["ap-southeast-1", "Asia Pacific (Singapore)"],
      ["ap-southeast-2", "Asia Pacific (Sydney)"],
      ["ap-southeast-3", "Asia Pacific (Jakarta)"],
      ["ap-southeast-5", "Asia Pacific (Malaysia)"],
      ["ap-northeast-1", "Asia Pacific (Tokyo)"],
      ["ap-northeast-2", "Asia Pacific (Seoul)"],
      ["ap-northeast-3", "Asia Pacific (Osaka)"],
    ],
  ],
  ["Middle East and Africa", [["me-south-1", "Middle East (Bahrain)"], ["me-central-1", "Middle East (UAE)"], ["il-central-1", "Israel (Tel Aviv)"], ["af-south-1", "Africa (Cape Town)"]]],
  ["AWS GovCloud", [["us-gov-east-1", "AWS GovCloud (US-East)"], ["us-gov-west-1", "AWS GovCloud (US-West)"]]],
];

export const isSesRegion = (code: string) => SES_REGIONS.some(([, regions]) => regions.some(([c]) => c === code));
