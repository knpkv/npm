/**
 * A sanitized excerpt of a live aws-nuke 3.68.3 dry run, from before the SAML
 * provider filter fix: it lists the Identity Center SAML provider for removal.
 * Account IDs and names are replaced; the 24 "would remove" lines are kept.
 */
export const dryRunListedSamlProvider =
  `global - IAMPolicy - arn:aws:iam::999999999999:policy/pool/PoolBoundary - [ARN: "arn:aws:iam::999999999999:policy/pool/PoolBoundary", CreateDate: "2026-10-16T09:41:07Z", Name: "PoolBoundary", Path: "/pool/", PolicyID: "ANPARCAJSCQWUL6FHHPPK"] - filtered: filtered by config
global - IAMRole - AWSReservedSSO_PoolDeveloper_84e6a56c0ae5642a - [CreateDate: "2026-10-16T08:35:15Z", LastUsedDate: "2026-10-16T08:35:15Z", Name: "AWSReservedSSO_PoolDeveloper_84e6a56c0ae5642a", Path: "/aws-reserved/sso.amazonaws.com/eu-central-1/"] - filtered: cannot delete SSO roles
global - IAMRole - AWSServiceRoleForOrganizations - [CreateDate: "2026-10-16T08:18:57Z", LastUsedDate: "2026-10-16T08:19:12Z", Name: "AWSServiceRoleForOrganizations", Path: "/aws-service-role/organizations.amazonaws.com/"] - filtered: cannot delete service roles
global - IAMRole - AWSServiceRoleForSSO - [CreateDate: "2026-10-16T08:19:12Z", LastUsedDate: "2026-10-16T08:35:15Z", Name: "AWSServiceRoleForSSO", Path: "/aws-service-role/sso.amazonaws.com/"] - filtered: cannot delete service roles
global - IAMRole - AWSServiceRoleForSupport - [CreateDate: "2026-10-16T08:18:55Z", LastUsedDate: "2026-10-16T08:18:55Z", Name: "AWSServiceRoleForSupport", Path: "/aws-service-role/support.amazonaws.com/"] - filtered: cannot delete service roles
global - IAMRole - AWSServiceRoleForTrustedAdvisor - [CreateDate: "2026-10-16T08:18:55Z", LastUsedDate: "2026-10-16T08:18:55Z", Name: "AWSServiceRoleForTrustedAdvisor", Path: "/aws-service-role/trustedadvisor.amazonaws.com/"] - filtered: cannot delete service roles
global - IAMSAMLProvider - arn:aws:iam::999999999999:saml-provider/AWSSSO_0123456789abcdef_DO_NOT_DELETE - [ARN: "arn:aws:iam::999999999999:saml-provider/AWSSSO_0123456789abcdef_DO_NOT_DELETE", CreateDate: "2026-10-16T08:35:14Z"] - would remove
eu-central-1 - EC2DHCPOption - dopt-05685597686eddf48 - [DefaultVPC: "true", OwnerID: "999999999999"] - would remove
eu-central-1 - EC2InternetGatewayAttachment - igw-0ae9613d61513c364 -> vpc-0f41977f30236cea0 - [DefaultVPC: "true", igw:OwnerID: "999999999999", vpc:OwnerID: "999999999999"] - would remove
eu-central-1 - EC2InternetGateway - igw-0ae9613d61513c364 - [DefaultVPC: "true", OwnerID: "999999999999"] - would remove
eu-central-1 - EC2Subnet - subnet-06d5be8cbf5b1129c - [DefaultForAz: "true", DefaultVPC: "true", OwnerID: "999999999999", VpcID: "vpc-0f41977f30236cea0"] - would remove
eu-central-1 - EC2Subnet - subnet-0f42daf26e5ba20c9 - [DefaultForAz: "true", DefaultVPC: "true", OwnerID: "999999999999", VpcID: "vpc-0f41977f30236cea0"] - would remove
eu-central-1 - EC2Subnet - subnet-085b93241925bc38b - [DefaultForAz: "true", DefaultVPC: "true", OwnerID: "999999999999", VpcID: "vpc-0f41977f30236cea0"] - would remove
eu-central-1 - EC2DefaultSecurityGroupRule - sgr-031f54a19df9fb05d - [DefaultVPC: "true", SecurityGroupId: "sg-01946198ed91d2b5a"] - would remove
eu-central-1 - EC2DefaultSecurityGroupRule - sgr-0c62f07232cdd8f53 - [DefaultVPC: "true", SecurityGroupId: "sg-01946198ed91d2b5a"] - would remove
eu-central-1 - AthenaWorkGroup - primary - [ARN: "arn:aws:athena:eu-central-1:999999999999:workgroup/primary", Name: "primary"] - would remove
eu-central-1 - EC2VPC - vpc-0f41977f30236cea0 - [ID: "vpc-0f41977f30236cea0", IsDefault: "true", OwnerID: "999999999999"] - would remove
us-east-1 - EC2DHCPOption - dopt-039c2f25c17bc2423 - [DefaultVPC: "true", OwnerID: "999999999999"] - would remove
us-east-1 - EC2InternetGatewayAttachment - igw-069b0f8afdb6a3bc3 -> vpc-091fa1dac477013db - [DefaultVPC: "true", igw:OwnerID: "999999999999", vpc:OwnerID: "999999999999"] - would remove
us-east-1 - EC2InternetGateway - igw-069b0f8afdb6a3bc3 - [DefaultVPC: "true", OwnerID: "999999999999"] - would remove
us-east-1 - EC2Subnet - subnet-07ac8e6ce03137cbf - [DefaultForAz: "true", DefaultVPC: "true", OwnerID: "999999999999", VpcID: "vpc-091fa1dac477013db"] - would remove
us-east-1 - EC2Subnet - subnet-05eb90917a80b5c70 - [DefaultForAz: "true", DefaultVPC: "true", OwnerID: "999999999999", VpcID: "vpc-091fa1dac477013db"] - would remove
us-east-1 - EC2Subnet - subnet-0dd272e9278039814 - [DefaultForAz: "true", DefaultVPC: "true", OwnerID: "999999999999", VpcID: "vpc-091fa1dac477013db"] - would remove
us-east-1 - EC2Subnet - subnet-080736e59031e0515 - [DefaultForAz: "true", DefaultVPC: "true", OwnerID: "999999999999", VpcID: "vpc-091fa1dac477013db"] - would remove
us-east-1 - EC2Subnet - subnet-0794610d7ebc29153 - [DefaultForAz: "true", DefaultVPC: "true", OwnerID: "999999999999", VpcID: "vpc-091fa1dac477013db"] - would remove
us-east-1 - EC2Subnet - subnet-036b77a90d0872131 - [DefaultForAz: "true", DefaultVPC: "true", OwnerID: "999999999999", VpcID: "vpc-091fa1dac477013db"] - would remove
us-east-1 - EC2DefaultSecurityGroupRule - sgr-08bbb9ceb5836d80e - [DefaultVPC: "true", SecurityGroupId: "sg-0040c28a7a4fcf2ef"] - would remove
us-east-1 - EC2DefaultSecurityGroupRule - sgr-0e1ec0d4a3aa04489 - [DefaultVPC: "true", SecurityGroupId: "sg-0040c28a7a4fcf2ef"] - would remove
us-east-1 - AthenaWorkGroup - primary - [ARN: "arn:aws:athena:us-east-1:999999999999:workgroup/primary", Name: "primary"] - would remove
us-east-1 - EC2VPC - vpc-091fa1dac477013db - [ID: "vpc-091fa1dac477013db", IsDefault: "true", OwnerID: "999999999999"] - would remove
Scan complete: 650 total, 24 nukeable, 626 filtered.`
