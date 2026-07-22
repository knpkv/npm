import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import type { SchemaError } from "effect/Schema"
import * as Schema from "effect/Schema"
import type * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientError from "effect/unstable/http/HttpClientError"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
// non-recursive definitions
export type AccountStatus = "ACTIVE" | "PENDING_EMAIL_VERIFICATION" | "DELETED" | "NOT_REGISTERED" | "LIMITED" | "LIMITED_DELETED"
export const AccountStatus = Schema.Literals(["ACTIVE", "PENDING_EMAIL_VERIFICATION", "DELETED", "NOT_REGISTERED", "LIMITED", "LIMITED_DELETED"]).annotate({ "description": "Represents account status enum." })
export type AddUserToWorkspaceRequest = { readonly "email": string }
export const AddUserToWorkspaceRequest = Schema.Struct({ "email": Schema.String.annotate({ "description": "Represents an email address of the user." }).check(Schema.isMinLength(1)) })
export type ApplyTaxes = never
export const ApplyTaxes = Schema.Never
export type ApprovalRequestCreatorDtoV1 = { readonly "userEmail"?: string, readonly "userId"?: string, readonly "userName"?: string }
export const ApprovalRequestCreatorDtoV1 = Schema.Struct({ "userEmail": Schema.optionalKey(Schema.String.annotate({ "description": "Represents user email." })), "userId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents user identifier across the system." })), "userName": Schema.optionalKey(Schema.String.annotate({ "description": "Represents user name." })) }).annotate({ "description": "Represents approval request creator object." })
export type ApprovalRequestOwnerDtoV1 = { readonly "startOfWeek"?: "MONDAY" | "TUESDAY" | "WEDNESDAY" | "THURSDAY" | "FRIDAY" | "SATURDAY" | "SUNDAY", readonly "timeZone"?: string, readonly "userId"?: string, readonly "userName"?: string }
export const ApprovalRequestOwnerDtoV1 = Schema.Struct({ "startOfWeek": Schema.optionalKey(Schema.Literals(["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"]).annotate({ "description": "Represents a day of the week." })), "timeZone": Schema.optionalKey(Schema.String.annotate({ "description": "Represents time zone." })), "userId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents user identifier across the system." })), "userName": Schema.optionalKey(Schema.String.annotate({ "description": "Represents user name." })) }).annotate({ "description": "Represents approval request owner object." })
export type ApprovalRequestStatusDtoV1 = { readonly "note"?: string, readonly "state"?: "PENDING" | "APPROVED" | "WITHDRAWN_SUBMISSION" | "WITHDRAWN_APPROVAL" | "REJECTED", readonly "updatedAt"?: string, readonly "updatedBy"?: string, readonly "updatedByUserName"?: string }
export const ApprovalRequestStatusDtoV1 = Schema.Struct({ "note": Schema.optionalKey(Schema.String.annotate({ "description": "Represents an approval requesst note." })), "state": Schema.optionalKey(Schema.Literals(["PENDING", "APPROVED", "WITHDRAWN_SUBMISSION", "WITHDRAWN_APPROVAL", "REJECTED"]).annotate({ "description": "Represents approval state enum." })), "updatedAt": Schema.optionalKey(Schema.String.annotate({ "description": "Represents a date in yyyy-MM-ddThh:mm:ssZ format.", "format": "date-time" })), "updatedBy": Schema.optionalKey(Schema.String.annotate({ "description": "Represents user identifier across the system." })), "updatedByUserName": Schema.optionalKey(Schema.String.annotate({ "description": "Represents user name." })) }).annotate({ "description": "Represents approval request status object." })
export type AssignmentPerDayDto = { readonly "date"?: string, readonly "hasAssignment"?: boolean }
export const AssignmentPerDayDto = Schema.Struct({ "date": Schema.optionalKey(Schema.String.annotate({ "format": "date-time" })), "hasAssignment": Schema.optionalKey(Schema.Boolean) }).annotate({ "description": "Represents a list of assignment per day objects." })
export type AssignmentUpdateRequestV1 = { readonly "billable"?: boolean, readonly "end": string, readonly "hoursPerDay"?: number, readonly "includeNonWorkingDays"?: boolean, readonly "note"?: string, readonly "seriesUpdateOption"?: "THIS_ONE" | "THIS_AND_FOLLOWING" | "ALL", readonly "start": string, readonly "startTime"?: string, readonly "taskId"?: string }
export const AssignmentUpdateRequestV1 = Schema.Struct({ "billable": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether assignment is billable or not." })), "end": Schema.String.annotate({ "description": "Represents an end date in the yyyy-MM-ddThh:mm:ssZ format." }), "hoursPerDay": Schema.optionalKey(Schema.Number.annotate({ "description": "Represents assignment total hours per day.", "format": "double" }).check(Schema.isFinite())), "includeNonWorkingDays": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether to include non-working days or not." })), "note": Schema.optionalKey(Schema.String.annotate({ "description": "Represents an assignment note." }).check(Schema.isMinLength(0)).check(Schema.isMaxLength(100))), "seriesUpdateOption": Schema.optionalKey(Schema.Literals(["THIS_ONE", "THIS_AND_FOLLOWING", "ALL"]).annotate({ "description": "Valid series option" })), "start": Schema.String.annotate({ "description": "Represents start date in yyyy-MM-ddThh:mm:ssZ format." }), "startTime": Schema.optionalKey(Schema.String.annotate({ "description": "Represents a start time in the hh:mm:ss format." })), "taskId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents task identifier across the system." })) })
export type AuthorizationSourceDtoV1 = { readonly "id"?: string, readonly "type"?: "USER_GROUP" }
export const AuthorizationSourceDtoV1 = Schema.Struct({ "id": Schema.optionalKey(Schema.String.annotate({ "description": "Represents authorization source identifier across the system." })), "type": Schema.optionalKey(Schema.Literal("USER_GROUP").annotate({ "description": "Represents a valid authorization source type." })) }).annotate({ "description": "Represents an authorization data transfer object." })
export type AutomaticAccrualDto = { readonly "amount"?: number, readonly "period"?: "MONTH" | "YEAR", readonly "timeUnit"?: "DAYS" | "HOURS" }
export const AutomaticAccrualDto = Schema.Struct({ "amount": Schema.optionalKey(Schema.Number.annotate({ "description": "Represents automatic accrual's amount", "format": "double" }).check(Schema.isFinite())), "period": Schema.optionalKey(Schema.Literals(["MONTH", "YEAR"]).annotate({ "description": "Represents automatic accrual's period" })), "timeUnit": Schema.optionalKey(Schema.Literals(["DAYS", "HOURS"]).annotate({ "description": "Represents automatic accrual's time unit" })) }).annotate({ "description": "Represents automatic approval settings." })
export type AutomaticAccrualRequest = { readonly "amount": number, readonly "period"?: "MONTH" | "YEAR", readonly "timeUnit"?: "DAYS" | "HOURS" }
export const AutomaticAccrualRequest = Schema.Struct({ "amount": Schema.Number.annotate({ "description": "Represents amount of automatic accrual.", "format": "double" }).check(Schema.isFinite()).check(Schema.isGreaterThanOrEqualTo(0)), "period": Schema.optionalKey(Schema.Literals(["MONTH", "YEAR"]).annotate({ "description": "Represents automatic accrual period." })), "timeUnit": Schema.optionalKey(Schema.Literals(["DAYS", "HOURS"]).annotate({ "description": "Represents automatic accrual time unit." })) }).annotate({ "description": "Provide automatic accrual settings." })
export type AutomaticLockDtoV1 = { readonly "changeDay"?: "MONDAY" | "TUESDAY" | "WEDNESDAY" | "THURSDAY" | "FRIDAY" | "SATURDAY" | "SUNDAY", readonly "dayOfMonth"?: number, readonly "firstDay"?: "MONDAY" | "TUESDAY" | "WEDNESDAY" | "THURSDAY" | "FRIDAY" | "SATURDAY" | "SUNDAY", readonly "olderThanPeriod"?: "DAYS" | "WEEKS" | "MONTHS", readonly "olderThanValue"?: number, readonly "type"?: "WEEKLY" | "MONTHLY" | "OLDER_THAN" }
export const AutomaticLockDtoV1 = Schema.Struct({ "changeDay": Schema.optionalKey(Schema.Literals(["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"]).annotate({ "description": "Represents a day of the week." })), "dayOfMonth": Schema.optionalKey(Schema.Number.annotate({ "description": "Represents a day of month as integer.", "format": "int32" }).check(Schema.isInt())), "firstDay": Schema.optionalKey(Schema.Literals(["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"]).annotate({ "description": "Represents a day of the week." })), "olderThanPeriod": Schema.optionalKey(Schema.Literals(["DAYS", "WEEKS", "MONTHS"]).annotate({ "description": "Represents a time entry automatic lock period enum." })), "olderThanValue": Schema.optionalKey(Schema.Number.annotate({ "description": "Represents an integer as the criteria for locking time entries.", "format": "int32" }).check(Schema.isInt())), "type": Schema.optionalKey(Schema.Literals(["WEEKLY", "MONTHLY", "OLDER_THAN"]).annotate({ "description": "Represents a time entry automatic lock type enum." })) }).annotate({ "description": "Represents an automatic lock object." })
export type BalanceDtoV1 = { readonly "balance"?: number, readonly "id"?: string, readonly "negativeBalanceAmount"?: number, readonly "negativeBalanceLimit"?: boolean, readonly "policyArchived"?: boolean, readonly "policyId"?: string, readonly "policyName"?: string, readonly "policyTimeUnit"?: "DAYS" | "HOURS", readonly "total"?: number, readonly "used"?: number, readonly "userId"?: string, readonly "userName"?: string, readonly "workspaceId"?: string }
export const BalanceDtoV1 = Schema.Struct({ "balance": Schema.optionalKey(Schema.Number.annotate({ "description": "Represents the balance amount of the time unit", "format": "double" }).check(Schema.isFinite())), "id": Schema.optionalKey(Schema.String.annotate({ "description": "Represent balance identifier across the system." })), "negativeBalanceAmount": Schema.optionalKey(Schema.Number.annotate({ "description": "Represent negative balance amount.", "format": "double" }).check(Schema.isFinite())), "negativeBalanceLimit": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether the negative balance limit is allowed." })), "policyArchived": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether the policy is archived." })), "policyId": Schema.optionalKey(Schema.String.annotate({ "description": "Represent policy identifier across the system." })), "policyName": Schema.optionalKey(Schema.String.annotate({ "description": "Represent policy name." })), "policyTimeUnit": Schema.optionalKey(Schema.Literals(["DAYS", "HOURS"]).annotate({ "description": "Represent policy time unit." })), "total": Schema.optionalKey(Schema.Number.annotate({ "description": "Represents the total amount", "format": "double" }).check(Schema.isFinite())), "used": Schema.optionalKey(Schema.Number.annotate({ "description": "Represents the balance used amount", "format": "double" }).check(Schema.isFinite())), "userId": Schema.optionalKey(Schema.String.annotate({ "description": "Represent user identifier across the system." })), "userName": Schema.optionalKey(Schema.String.annotate({ "description": "Represent user's username." })), "workspaceId": Schema.optionalKey(Schema.String.annotate({ "description": "Represent workspace identifier across the system." })) }).annotate({ "description": "Represent the list of balances." })
export type BaseFilterRequest = { readonly "contains"?: "CONTAINS" | "DOES_NOT_CONTAIN" | "CONTAINS_ONLY", readonly "ids"?: ReadonlyArray<string> }
export const BaseFilterRequest = Schema.Struct({ "contains": Schema.optionalKey(Schema.Literals(["CONTAINS", "DOES_NOT_CONTAIN", "CONTAINS_ONLY"]).annotate({ "description": "Filter type." })), "ids": Schema.optionalKey(Schema.Array(Schema.String.annotate({ "description": "Represents a list of filter identifiers." })).annotate({ "description": "Represents a list of filter identifiers." }).check(Schema.isUnique())) }).annotate({ "description": "Represents a company filter object. If provided, you'll get a filtered list of invoices that matches the specified company filter." })
export type CalculationType = never
export const CalculationType = Schema.Never
export type ChangeInvoiceStatusRequestV1 = { readonly "invoiceStatus"?: "UNSENT" | "SENT" | "PAID" | "PARTIALLY_PAID" | "VOID" | "OVERDUE" }
export const ChangeInvoiceStatusRequestV1 = Schema.Struct({ "invoiceStatus": Schema.optionalKey(Schema.Literals(["UNSENT", "SENT", "PAID", "PARTIALLY_PAID", "VOID", "OVERDUE"]).annotate({ "description": "Represents the invoice status to be set." })) })
export type ChangePolicyStatusRequestV1 = { readonly "status": "ACTIVE" | "ARCHIVED" | "ALL" }
export const ChangePolicyStatusRequestV1 = Schema.Struct({ "status": Schema.Literals(["ACTIVE", "ARCHIVED", "ALL"]).annotate({ "description": "Provide the status you would like to use for changing the policy." }) })
export type ClientDtoV1 = { readonly "address"?: string, readonly "archived"?: boolean, readonly "ccEmails"?: ReadonlyArray<string>, readonly "currencyId"?: string, readonly "email"?: string, readonly "id"?: string, readonly "name"?: string, readonly "note"?: string, readonly "workspaceId"?: string }
export const ClientDtoV1 = Schema.Struct({ "address": Schema.optionalKey(Schema.String.annotate({ "description": "Represents client's address." })), "archived": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Represents whether a client is archived or not." })), "ccEmails": Schema.optionalKey(Schema.Array(Schema.String.annotate({ "description": "Represents additional emails for sending invoices." })).annotate({ "description": "Represents additional emails for sending invoices." })), "currencyId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents currency identifier across the system." })), "email": Schema.optionalKey(Schema.String.annotate({ "description": "Represents client email." })), "id": Schema.optionalKey(Schema.String.annotate({ "description": "Represents client identifier across the system." })), "name": Schema.optionalKey(Schema.String.annotate({ "description": "Represents client name." })), "note": Schema.optionalKey(Schema.String.annotate({ "description": "Represents saved notes for the client." })), "workspaceId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents workspace identifier across the system." })) })
export type ClientWithCurrencyDtoV1 = { readonly "address"?: string, readonly "archived"?: boolean, readonly "ccEmails"?: ReadonlyArray<string>, readonly "currencyCode"?: string, readonly "currencyId"?: string, readonly "email"?: string, readonly "id"?: string, readonly "name"?: string, readonly "note"?: string, readonly "workspaceId"?: string }
export const ClientWithCurrencyDtoV1 = Schema.Struct({ "address": Schema.optionalKey(Schema.String.annotate({ "description": "Represents client's address." })), "archived": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Represents whether a client is archived or not." })), "ccEmails": Schema.optionalKey(Schema.Array(Schema.String.annotate({ "description": "Represents additional emails for sending invoices." })).annotate({ "description": "Represents additional emails for sending invoices." })), "currencyCode": Schema.optionalKey(Schema.String.annotate({ "description": "Represents client currency code." })), "currencyId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents currency identifier across the system." })), "email": Schema.optionalKey(Schema.String.annotate({ "description": "Represents client email." })), "id": Schema.optionalKey(Schema.String.annotate({ "description": "Represents client identifier across the system." })), "name": Schema.optionalKey(Schema.String.annotate({ "description": "Represents client name." })), "note": Schema.optionalKey(Schema.String.annotate({ "description": "Represents saved notes for the client." })), "workspaceId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents workspace identifier across the system." })) })
export type ContainsArchivedFilterRequest = { readonly "contains"?: "CONTAINS" | "DOES_NOT_CONTAIN" | "CONTAINS_ONLY", readonly "ids"?: ReadonlyArray<string>, readonly "status"?: "ACTIVE" | "ARCHIVED" | "ALL" }
export const ContainsArchivedFilterRequest = Schema.Struct({ "contains": Schema.optionalKey(Schema.Literals(["CONTAINS", "DOES_NOT_CONTAIN", "CONTAINS_ONLY"]).annotate({ "description": "Filter type." })), "ids": Schema.optionalKey(Schema.Array(Schema.String.annotate({ "description": "Represents a list of filter identifiers." })).annotate({ "description": "Represents a list of filter identifiers." }).check(Schema.isUnique())), "status": Schema.optionalKey(Schema.Literals(["ACTIVE", "ARCHIVED", "ALL"]).annotate({ "description": "Filters entities by status." })) }).annotate({ "description": "Represents a project filter for imported items." })
export type ContainsUserGroupFilterRequest = { readonly "contains"?: "CONTAINS" | "DOES_NOT_CONTAIN" | "CONTAINS_ONLY", readonly "ids"?: ReadonlyArray<string>, readonly "status"?: "PENDING" | "ACTIVE" | "DECLINED" | "INACTIVE" | "ALL" }
export const ContainsUserGroupFilterRequest = Schema.Struct({ "contains": Schema.optionalKey(Schema.Literals(["CONTAINS", "DOES_NOT_CONTAIN", "CONTAINS_ONLY"]).annotate({ "description": "Filter type." })), "ids": Schema.optionalKey(Schema.Array(Schema.String.annotate({ "description": "Represents a list of filter identifiers." })).annotate({ "description": "Represents a list of filter identifiers." }).check(Schema.isUnique())), "status": Schema.optionalKey(Schema.Literals(["PENDING", "ACTIVE", "DECLINED", "INACTIVE", "ALL"]).annotate({ "description": "Filters entities by status." })) }).annotate({ "description": "Provide list with user group ids and corresponding status." })
export type ContainsUserGroupFilterRequestV1 = { readonly "contains"?: "CONTAINS" | "DOES_NOT_CONTAIN" | "CONTAINS_ONLY", readonly "ids"?: ReadonlyArray<string>, readonly "status"?: "PENDING" | "ACTIVE" | "DECLINED" | "INACTIVE" | "ALL" }
export const ContainsUserGroupFilterRequestV1 = Schema.Struct({ "contains": Schema.optionalKey(Schema.Literals(["CONTAINS", "DOES_NOT_CONTAIN", "CONTAINS_ONLY"]).annotate({ "description": "Filter type." })), "ids": Schema.optionalKey(Schema.Array(Schema.String.annotate({ "description": "Represents a list of filter identifiers." })).annotate({ "description": "Represents a list of filter identifiers." }).check(Schema.isUnique())), "status": Schema.optionalKey(Schema.Literals(["PENDING", "ACTIVE", "DECLINED", "INACTIVE", "ALL"]).annotate({ "description": "Filters entities by status." })) }).annotate({ "description": "Represents a user group filter request object." })
export type ContainsUsersFilterRequestForHoliday = { readonly "contains"?: "CONTAINS" | "DOES_NOT_CONTAIN" | "CONTAINS_ONLY", readonly "ids"?: ReadonlyArray<string>, readonly "status"?: "ALL" | "ACTIVE" | "INACTIVE", readonly "statuses"?: ReadonlyArray<string> }
export const ContainsUsersFilterRequestForHoliday = Schema.Struct({ "contains": Schema.optionalKey(Schema.Literals(["CONTAINS", "DOES_NOT_CONTAIN", "CONTAINS_ONLY"]).annotate({ "description": "Filter type." })), "ids": Schema.optionalKey(Schema.Array(Schema.String.annotate({ "description": "Represents a list of filter identifiers." })).annotate({ "description": "Represents a list of filter identifiers." }).check(Schema.isUnique())), "status": Schema.optionalKey(Schema.Literals(["ALL", "ACTIVE", "INACTIVE"]).annotate({ "description": "Filters entities by status." })), "statuses": Schema.optionalKey(Schema.Array(Schema.String)) }).annotate({ "description": "Provide list with users ids and corresponding status." })
export type ContainsUsersFilterRequestV1 = { readonly "contains"?: "CONTAINS" | "DOES_NOT_CONTAIN" | "CONTAINS_ONLY", readonly "ids"?: ReadonlyArray<string>, readonly "sourceType"?: "USER_GROUP", readonly "status"?: "PENDING" | "ACTIVE" | "DECLINED" | "INACTIVE" | "ALL", readonly "statuses"?: ReadonlyArray<"PENDING" | "ACTIVE" | "DECLINED" | "INACTIVE" | "ALL"> }
export const ContainsUsersFilterRequestV1 = Schema.Struct({ "contains": Schema.optionalKey(Schema.Literals(["CONTAINS", "DOES_NOT_CONTAIN", "CONTAINS_ONLY"]).annotate({ "description": "Filter type." })), "ids": Schema.optionalKey(Schema.Array(Schema.String.annotate({ "description": "Represents a list of filter identifiers." })).annotate({ "description": "Represents a list of filter identifiers." }).check(Schema.isUnique())), "sourceType": Schema.optionalKey(Schema.Literal("USER_GROUP").annotate({ "description": "Valid authorization source type." })), "status": Schema.optionalKey(Schema.Literals(["PENDING", "ACTIVE", "DECLINED", "INACTIVE", "ALL"]).annotate({ "description": "Filters entities by status." })), "statuses": Schema.optionalKey(Schema.Array(Schema.Literals(["PENDING", "ACTIVE", "DECLINED", "INACTIVE", "ALL"]).annotate({ "description": "Valid array of membership statuses." })).annotate({ "description": "Valid array of membership statuses." })) }).annotate({ "description": "Represents a user filter request object." })
export type CopyAssignmentRequestV1 = { readonly "seriesUpdateOption"?: "THIS_ONE" | "THIS_AND_FOLLOWING" | "ALL", readonly "userId": string }
export const CopyAssignmentRequestV1 = Schema.Struct({ "seriesUpdateOption": Schema.optionalKey(Schema.Literals(["THIS_ONE", "THIS_AND_FOLLOWING", "ALL"]).annotate({ "description": "Represents a series update option." })), "userId": Schema.String.annotate({ "description": "Represents a user identifier across the system." }) })
export type CostRateRequest = { readonly "amount"?: number, readonly "since"?: string, readonly "sinceAsInstant"?: string }
export const CostRateRequest = Schema.Struct({ "amount": Schema.optionalKey(Schema.Number.annotate({ "description": "Represents an amount as integer.", "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0))), "since": Schema.optionalKey(Schema.String.annotate({ "description": "Represents a datetime in yyyy-MM-ddThh:mm:ssZ format." })), "sinceAsInstant": Schema.optionalKey(Schema.String.annotate({ "format": "date-time" })) }).annotate({ "description": "Represents a cost rate request object." })
export type CostRateRequestV1 = { readonly "amount": number, readonly "since"?: string }
export const CostRateRequestV1 = Schema.Struct({ "amount": Schema.Number.annotate({ "description": "Represents an amount as integer.", "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0)), "since": Schema.optionalKey(Schema.String.annotate({ "description": "Represents a date and time in yyyy-MM-ddThh:mm:ssZ format." })) })
export type CreateApprovalRequest = { readonly "period"?: "WEEKLY" | "SEMI_MONTHLY" | "MONTHLY", readonly "periodStart": string }
export const CreateApprovalRequest = Schema.Struct({ "period": Schema.optionalKey(Schema.Literals(["WEEKLY", "SEMI_MONTHLY", "MONTHLY"]).annotate({ "description": "Specifies the approval period. It has to match the workspace approval period setting." })), "periodStart": Schema.String.annotate({ "description": "Specifies an approval period start date in yyyy-MM-ddThh:mm:ssZ format." }).check(Schema.isMinLength(1)) })
export type CreateClientRequestV1 = { readonly "address"?: string, readonly "email"?: string, readonly "name"?: string, readonly "note"?: string }
export const CreateClientRequestV1 = Schema.Struct({ "address": Schema.optionalKey(Schema.String.annotate({ "description": "Represents a client's address." }).check(Schema.isMinLength(0)).check(Schema.isMaxLength(3000))), "email": Schema.optionalKey(Schema.String.annotate({ "description": "Represents a client email.", "format": "email" })), "name": Schema.optionalKey(Schema.String.annotate({ "description": "Represents a client name." }).check(Schema.isMinLength(0)).check(Schema.isMaxLength(100))), "note": Schema.optionalKey(Schema.String.annotate({ "description": "Represents additional notes for the client." }).check(Schema.isMinLength(0)).check(Schema.isMaxLength(3000))) })
export type CreateCustomAttributeRequest = { readonly "name": string, readonly "namespace": string, readonly "value": string }
export const CreateCustomAttributeRequest = Schema.Struct({ "name": Schema.String.annotate({ "description": "Represents custom attribute name." }).check(Schema.isMinLength(1)), "namespace": Schema.String.annotate({ "description": "Represents custom attribute namespace." }).check(Schema.isMinLength(1)), "value": Schema.String.annotate({ "description": "Represents custom attribute value." }).check(Schema.isMinLength(1)) }).annotate({ "description": "Represents a list of create custom field request objects." })
export type CreateExpenseV1Request = { readonly "amount": number, readonly "billable"?: boolean, readonly "categoryId": string, readonly "date": string, readonly "file": string, readonly "notes"?: string, readonly "projectId": string, readonly "taskId"?: string, readonly "userId": string }
export const CreateExpenseV1Request = Schema.Struct({ "amount": Schema.Number.annotate({ "description": "Represents an expense amount as the double data type.", "format": "double" }).check(Schema.isFinite()).check(Schema.isLessThanOrEqualTo(92233720368547760)), "billable": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether expense is billable or not." })), "categoryId": Schema.String.annotate({ "description": "Represents a category identifier across the system." }), "date": Schema.String.annotate({ "description": "Provides a valid yyyy-MM-ddThh:mm:ssZ format date.", "format": "date-time" }), "file": Schema.String.annotate({ "format": "binary" }), "notes": Schema.optionalKey(Schema.String.annotate({ "description": "Represents notes for an expense." }).check(Schema.isMinLength(0)).check(Schema.isMaxLength(3000))), "projectId": Schema.String.annotate({ "description": "Represents a project identifier across the system." }), "taskId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents a task identifier across the system." })), "userId": Schema.String.annotate({ "description": "Represents a user identifier across the system." }).check(Schema.isMinLength(1)) })
export type CreateInvoiceDtoV1 = { readonly "billFrom"?: string, readonly "clientId"?: string, readonly "currency"?: string, readonly "dueDate"?: string, readonly "id"?: string, readonly "issuedDate"?: string, readonly "number"?: string }
export const CreateInvoiceDtoV1 = Schema.Struct({ "billFrom": Schema.optionalKey(Schema.String.annotate({ "description": "Represents to whom the invoice should be billed from." })), "clientId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents client identifier across the system." })), "currency": Schema.optionalKey(Schema.String.annotate({ "description": "Represents the currency used by the invoice." })), "dueDate": Schema.optionalKey(Schema.String.annotate({ "description": "Represents an invoice due date in yyyy-MM-ddThh:mm:ssZ format.", "format": "date-time" })), "id": Schema.optionalKey(Schema.String.annotate({ "description": "Represents invoice identifier across the system." })), "issuedDate": Schema.optionalKey(Schema.String.annotate({ "description": "Represents an invoice issued date in yyyy-MM-ddThh:mm:ssZ format.", "format": "date-time" })), "number": Schema.optionalKey(Schema.String.annotate({ "description": "Represents an invoice number." })) })
export type CreateInvoiceItemRequestV1 = { readonly "applyTaxes": "TAX1" | "TAX2" | "TAX1TAX2" | "NONE", readonly "description": string, readonly "itemType": string, readonly "quantity": number, readonly "unitPrice": number }
export const CreateInvoiceItemRequestV1 = Schema.Struct({ "applyTaxes": Schema.Literals(["TAX1", "TAX2", "TAX1TAX2", "NONE"]).annotate({ "description": "Represents taxes applied to the invoice item. Applies only when the specified taxes are active on the invoice." }), "description": Schema.String.annotate({ "description": "Represents an invoice item description." }), "itemType": Schema.String.annotate({ "description": "Represents an item type." }).check(Schema.isMinLength(1)), "quantity": Schema.Number.annotate({ "description": "Represents an item quantity.", "format": "int64" }).check(Schema.isInt()), "unitPrice": Schema.Number.annotate({ "description": "Represents an item unit price.", "format": "int64" }).check(Schema.isInt()) })
export type CreateInvoicePaymentRequest = { readonly "amount"?: number, readonly "note"?: string, readonly "paymentDate"?: string }
export const CreateInvoicePaymentRequest = Schema.Struct({ "amount": Schema.optionalKey(Schema.Number.annotate({ "description": "Represents an invoice payment amount as long.", "format": "int64" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1))), "note": Schema.optionalKey(Schema.String.annotate({ "description": "Represents an invoice payment note." }).check(Schema.isMinLength(0)).check(Schema.isMaxLength(1000))), "paymentDate": Schema.optionalKey(Schema.String.annotate({ "description": "Represents an invoice payment date in yyyy-MM-ddThh:mm:ssZ format." })) })
export type CreateInvoiceRequest = { readonly "clientId": string, readonly "currency": string, readonly "dueDate": string, readonly "issuedDate": string, readonly "number": string, readonly "timeViewMode"?: "TIME_SENSITIVE_VIEW" | "AGGREGATED_TIME_VIEW" }
export const CreateInvoiceRequest = Schema.Struct({ "clientId": Schema.String.annotate({ "description": "Represents a client identifier across the system." }).check(Schema.isMinLength(1)), "currency": Schema.String.annotate({ "description": "Represents the currency used by the invoice." }).check(Schema.isMinLength(1)), "dueDate": Schema.String.annotate({ "description": "Represents an invoice due date in yyyy-MM-ddThh:mm:ssZ format.", "format": "date-time" }), "issuedDate": Schema.String.annotate({ "description": "Represents an invoice issued date in yyyy-MM-ddThh:mm:ssZ format.", "format": "date-time" }), "number": Schema.String.annotate({ "description": "Represents an invoice number." }).check(Schema.isMinLength(1)), "timeViewMode": Schema.optionalKey(Schema.Literals(["TIME_SENSITIVE_VIEW", "AGGREGATED_TIME_VIEW"])) })
export type CreateProjectFromTemplateV1 = { readonly "clientId"?: string, readonly "color"?: string, readonly "isPublic"?: boolean, readonly "name": string, readonly "templateProjectId": string }
export const CreateProjectFromTemplateV1 = Schema.Struct({ "clientId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents a client identifier across the system." })), "color": Schema.optionalKey(Schema.String.annotate({ "description": "Color format ^#(?:[0-9a-fA-F]{6}){1}$. Explanation: A valid color code should start with '#' and consist of six hexadecimal characters, representing a color in hexadecimal format. Color value is in standard RGB hexadecimal format." }).check(Schema.isPattern(new RegExp("^#(?:[0-9a-fA-F]{6}){1}$")))), "isPublic": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether the project is public or not." })), "name": Schema.String.annotate({ "description": "Represents a project name." }).check(Schema.isMinLength(2)).check(Schema.isMaxLength(250)), "templateProjectId": Schema.String.annotate({ "description": "Represents a project identifier across the system." }).check(Schema.isMinLength(1)) })
export type CreateRecurringAssignmentRequestV1 = { readonly "repeat"?: boolean, readonly "weeks": number }
export const CreateRecurringAssignmentRequestV1 = Schema.Struct({ "repeat": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether assignment is recurring or not." })), "weeks": Schema.Number.annotate({ "description": "Indicates number of weeks for assignment.", "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(99)) }).annotate({ "description": "Represents a recurring assignment object. This parameter is optional." })
export type CreateWebhookRequestV1 = { readonly "name"?: string, readonly "triggerSource": ReadonlyArray<string>, readonly "triggerSourceType": "PROJECT_ID" | "USER_ID" | "TAG_ID" | "TASK_ID" | "WORKSPACE_ID" | "ASSIGNMENT_ID" | "EXPENSE_ID", readonly "url": string, readonly "webhookEvent": "NEW_PROJECT" | "NEW_TASK" | "NEW_CLIENT" | "NEW_TIMER_STARTED" | "TIMER_STOPPED" | "TIME_ENTRY_UPDATED" | "TIME_ENTRY_DELETED" | "TIME_ENTRY_SPLIT" | "NEW_TIME_ENTRY" | "TIME_ENTRY_RESTORED" | "NEW_TAG" | "USER_DELETED_FROM_WORKSPACE" | "USER_JOINED_WORKSPACE" | "USER_DEACTIVATED_ON_WORKSPACE" | "USER_ACTIVATED_ON_WORKSPACE" | "USER_EMAIL_CHANGED" | "USER_UPDATED" | "NEW_INVOICE" | "INVOICE_UPDATED" | "NEW_APPROVAL_REQUEST" | "APPROVAL_REQUEST_STATUS_UPDATED" | "TIME_OFF_REQUESTED" | "TIME_OFF_REQUEST_UPDATED" | "TIME_OFF_REQUEST_APPROVED" | "TIME_OFF_REQUEST_REJECTED" | "TIME_OFF_REQUEST_STARTED" | "TIME_OFF_REQUEST_WITHDRAWN" | "BALANCE_UPDATED" | "TAG_UPDATED" | "TAG_DELETED" | "TASK_UPDATED" | "CLIENT_UPDATED" | "TASK_DELETED" | "CLIENT_DELETED" | "EXPENSE_RESTORED" | "ASSIGNMENT_CREATED" | "ASSIGNMENT_DELETED" | "ASSIGNMENT_PUBLISHED" | "ASSIGNMENT_UPDATED" | "EXPENSE_CREATED" | "EXPENSE_DELETED" | "EXPENSE_UPDATED" | "PROJECT_UPDATED" | "PROJECT_DELETED" | "USER_GROUP_CREATED" | "USER_GROUP_UPDATED" | "USER_GROUP_DELETED" | "USERS_INVITED_TO_WORKSPACE" | "LIMITED_USERS_ADDED_TO_WORKSPACE" | "COST_RATE_UPDATED" | "BILLABLE_RATE_UPDATED" }
export const CreateWebhookRequestV1 = Schema.Struct({ "name": Schema.optionalKey(Schema.String.annotate({ "description": "Represents a webhook name." }).check(Schema.isMinLength(2)).check(Schema.isMaxLength(30))), "triggerSource": Schema.Array(Schema.String.annotate({ "description": "Represents a list of trigger sources." })).annotate({ "description": "Represents a list of trigger sources." }), "triggerSourceType": Schema.Literals(["PROJECT_ID", "USER_ID", "TAG_ID", "TASK_ID", "WORKSPACE_ID", "ASSIGNMENT_ID", "EXPENSE_ID"]).annotate({ "description": "Represents a webhook event trigger source type." }), "url": Schema.String.annotate({ "description": "Represents a webhook target url." }).check(Schema.isMinLength(1)), "webhookEvent": Schema.Literals(["NEW_PROJECT", "NEW_TASK", "NEW_CLIENT", "NEW_TIMER_STARTED", "TIMER_STOPPED", "TIME_ENTRY_UPDATED", "TIME_ENTRY_DELETED", "TIME_ENTRY_SPLIT", "NEW_TIME_ENTRY", "TIME_ENTRY_RESTORED", "NEW_TAG", "USER_DELETED_FROM_WORKSPACE", "USER_JOINED_WORKSPACE", "USER_DEACTIVATED_ON_WORKSPACE", "USER_ACTIVATED_ON_WORKSPACE", "USER_EMAIL_CHANGED", "USER_UPDATED", "NEW_INVOICE", "INVOICE_UPDATED", "NEW_APPROVAL_REQUEST", "APPROVAL_REQUEST_STATUS_UPDATED", "TIME_OFF_REQUESTED", "TIME_OFF_REQUEST_UPDATED", "TIME_OFF_REQUEST_APPROVED", "TIME_OFF_REQUEST_REJECTED", "TIME_OFF_REQUEST_STARTED", "TIME_OFF_REQUEST_WITHDRAWN", "BALANCE_UPDATED", "TAG_UPDATED", "TAG_DELETED", "TASK_UPDATED", "CLIENT_UPDATED", "TASK_DELETED", "CLIENT_DELETED", "EXPENSE_RESTORED", "ASSIGNMENT_CREATED", "ASSIGNMENT_DELETED", "ASSIGNMENT_PUBLISHED", "ASSIGNMENT_UPDATED", "EXPENSE_CREATED", "EXPENSE_DELETED", "EXPENSE_UPDATED", "PROJECT_UPDATED", "PROJECT_DELETED", "USER_GROUP_CREATED", "USER_GROUP_UPDATED", "USER_GROUP_DELETED", "USERS_INVITED_TO_WORKSPACE", "LIMITED_USERS_ADDED_TO_WORKSPACE", "COST_RATE_UPDATED", "BILLABLE_RATE_UPDATED"]).annotate({ "description": "Represents a webhook event type." }) })
export type CreateWorkspaceRequestV1 = { readonly "name"?: string, readonly "organizationId"?: string }
export const CreateWorkspaceRequestV1 = Schema.Struct({ "name": Schema.optionalKey(Schema.String.annotate({ "description": "Represents a workspace name." }).check(Schema.isMinLength(1)).check(Schema.isMaxLength(50))), "organizationId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents the Cake organization identifier across the system." })) })
export type CurrencyWithDefaultInfoDtoV1 = { readonly "code"?: string, readonly "id"?: string, readonly "isDefault"?: boolean }
export const CurrencyWithDefaultInfoDtoV1 = Schema.Struct({ "code": Schema.optionalKey(Schema.String.annotate({ "description": "Represents currency code." })), "id": Schema.optionalKey(Schema.String.annotate({ "description": "Represents currency identifier across the system." })), "isDefault": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether curency should be set as default." })) }).annotate({ "description": "Represents currency with default info object." })
export type CustomFieldDefaultValuesDtoV1 = { readonly "projectId"?: string, readonly "status"?: string, readonly "value"?: {  } }
export const CustomFieldDefaultValuesDtoV1 = Schema.Struct({ "projectId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents project identifier across the system." })), "status": Schema.optionalKey(Schema.String.annotate({ "description": "Represents custom field status" })), "value": Schema.optionalKey(Schema.Struct({  }).annotate({ "description": "Represents a custom field's default value" })) }).annotate({ "description": "Represents a list of custom field default values data transfer objects." })
export type CustomFieldProjectDefaultValuesRequest = { readonly "defaultValue"?: {  }, readonly "status"?: "INACTIVE" | "VISIBLE" | "INVISIBLE" }
export const CustomFieldProjectDefaultValuesRequest = Schema.Struct({ "defaultValue": Schema.optionalKey(Schema.Struct({  }).annotate({ "description": "Represents a custom field's default value." })), "status": Schema.optionalKey(Schema.Literals(["INACTIVE", "VISIBLE", "INVISIBLE"]).annotate({ "description": "Represents a custom field status." })) })
export type CustomFieldRequestV1 = { readonly "allowedValues"?: ReadonlyArray<string>, readonly "description"?: string, readonly "entityType"?: "TIMEENTRY" | "USER", readonly "name": string, readonly "onlyAdminCanEdit"?: boolean, readonly "placeholder"?: string, readonly "status"?: "INACTIVE" | "VISIBLE" | "INVISIBLE", readonly "type": "TXT" | "NUMBER" | "DROPDOWN_SINGLE" | "DROPDOWN_MULTIPLE" | "CHECKBOX" | "LINK", readonly "workspaceDefaultValue"?: {  } }
export const CustomFieldRequestV1 = Schema.Struct({ "allowedValues": Schema.optionalKey(Schema.Array(Schema.String.annotate({ "description": "Represents a list of custom field's allowed values." })).annotate({ "description": "Represents a list of custom field's allowed values." })), "description": Schema.optionalKey(Schema.String.annotate({ "description": "Represents custom field description." })), "entityType": Schema.optionalKey(Schema.Literals(["TIMEENTRY", "USER"]).annotate({ "description": "Represents custom field entity type" })), "name": Schema.String.annotate({ "description": "Represents custom field name." }), "onlyAdminCanEdit": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Flag to set whether custom field is modifiable only by admin users." })), "placeholder": Schema.optionalKey(Schema.String.annotate({ "description": "Represents custom field placeholder value." })), "status": Schema.optionalKey(Schema.Literals(["INACTIVE", "VISIBLE", "INVISIBLE"]).annotate({ "description": "Represents custom field status" })), "type": Schema.Literals(["TXT", "NUMBER", "DROPDOWN_SINGLE", "DROPDOWN_MULTIPLE", "CHECKBOX", "LINK"]).annotate({ "description": "Represents custom field type." }), "workspaceDefaultValue": Schema.optionalKey(Schema.Struct({  }).annotate({ "description": "Represents a custom field's default value in the workspace.<li>if type = NUMBER, then value must be a number</li><li>if type = DROPDOWN_MULTIPLE, value must be a list</li><li>if type = CHECKBOX, value must be true/false</li><li>otherwise any string</li>" })) })
export type CustomFieldType = never
export const CustomFieldType = Schema.Never
export type CustomFieldValueDto = { readonly "customFieldId"?: string, readonly "sourceType"?: "WORKSPACE" | "PROJECT" | "TIMEENTRY", readonly "timeEntryId"?: string, readonly "value"?: {  } }
export const CustomFieldValueDto = Schema.Struct({ "customFieldId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents custom field identifier across the system." })), "sourceType": Schema.optionalKey(Schema.Literals(["WORKSPACE", "PROJECT", "TIMEENTRY"]).annotate({ "description": "Represents a custom field value source type." })), "timeEntryId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents time entry identifier across the system." })), "value": Schema.optionalKey(Schema.Struct({  }).annotate({ "description": "Represents custom field value." })) }).annotate({ "description": "Represents a list of custom field value objects." })
export type CustomFieldValueDtoV1 = { readonly "customFieldId"?: string, readonly "name"?: string, readonly "timeEntryId"?: string, readonly "type"?: string, readonly "value"?: {  } }
export const CustomFieldValueDtoV1 = Schema.Struct({ "customFieldId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents custom field identifier across the system." })), "name": Schema.optionalKey(Schema.String.annotate({ "description": "Represents custom field name." })), "timeEntryId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents time entry identifier across the system." })), "type": Schema.optionalKey(Schema.String.annotate({ "description": "Represents a custom field value source type." })), "value": Schema.optionalKey(Schema.Struct({  }).annotate({ "description": "Represents custom field value." })) }).annotate({ "description": "Represents a list of custom field value objects." })
export type DatePeriod = { readonly "endDate"?: string, readonly "startDate"?: string }
export const DatePeriod = Schema.Struct({ "endDate": Schema.optionalKey(Schema.String.annotate({ "format": "date" })), "startDate": Schema.optionalKey(Schema.String.annotate({ "format": "date" })) }).annotate({ "description": "Represents startDate and endDate of the holiday. Date is in format yyyy-mm-dd" })
export type DatePeriodRequest = { readonly "endDate": string, readonly "startDate": string }
export const DatePeriodRequest = Schema.Struct({ "endDate": Schema.String.annotate({ "description": "yyyy-MM-dd format date" }).check(Schema.isMinLength(1)), "startDate": Schema.String.annotate({ "description": "yyyy-MM-dd format date" }).check(Schema.isMinLength(1)) }).annotate({ "description": "Provide startDate and endDate for the holiday." })
export type DateRangeDto = { readonly "end"?: string, readonly "start"?: string }
export const DateRangeDto = Schema.Struct({ "end": Schema.optionalKey(Schema.String.annotate({ "format": "date-time" })), "start": Schema.optionalKey(Schema.String.annotate({ "format": "date-time" })) }).annotate({ "description": "Represents date range object." })
export type DefaultEntitiesDto = { readonly "projectId"?: string, readonly "taskId"?: string }
export const DefaultEntitiesDto = Schema.Struct({ "projectId": Schema.optionalKey(Schema.String), "taskId": Schema.optionalKey(Schema.String) })
export type DefaultEntitiesRequest = { readonly "projectId"?: string, readonly "taskId"?: string }
export const DefaultEntitiesRequest = Schema.Struct({ "projectId": Schema.optionalKey(Schema.String.annotate({ "description": "Default project for automatically created time entries" })), "taskId": Schema.optionalKey(Schema.String.annotate({ "description": "Default task for automatically created time entries" })) }).annotate({ "description": "Provides information about default project and task for automatically created time entries." })
export type EntityCreationPermission = never
export const EntityCreationPermission = Schema.Never
export type EntityIdNameDto = { readonly "id"?: string, readonly "name"?: string }
export const EntityIdNameDto = Schema.Struct({ "id": Schema.optionalKey(Schema.String), "name": Schema.optionalKey(Schema.String) }).annotate({ "description": "Contains names of user groups that are assigned to holiday." })
export type EstimateDtoV1 = { readonly "estimate"?: string, readonly "type"?: "AUTO" | "MANUAL" }
export const EstimateDtoV1 = Schema.Struct({ "estimate": Schema.optionalKey(Schema.String.annotate({ "description": "Represents a task duration estimate." })), "type": Schema.optionalKey(Schema.Literals(["AUTO", "MANUAL"]).annotate({ "description": "Represents an estimate type enum." })) }).annotate({ "description": "Represents a project estimate object." })
export type EstimateRequest = { readonly "estimate"?: string, readonly "type"?: "AUTO" | "MANUAL" }
export const EstimateRequest = Schema.Struct({ "estimate": Schema.optionalKey(Schema.String.annotate({ "description": "Represents a time duration in ISO-8601 format." })), "type": Schema.optionalKey(Schema.Literals(["AUTO", "MANUAL"]).annotate({ "description": "Represents an estimate type enum." })) }).annotate({ "description": "Represents an estimate request object." })
export type EstimateResetDto = { readonly "dayOfMonth"?: number, readonly "dayOfWeek"?: "MONDAY" | "TUESDAY" | "WEDNESDAY" | "THURSDAY" | "FRIDAY" | "SATURDAY" | "SUNDAY", readonly "hour"?: number, readonly "interval"?: "WEEKLY" | "MONTHLY" | "YEARLY", readonly "month"?: "JANUARY" | "FEBRUARY" | "MARCH" | "APRIL" | "MAY" | "JUNE" | "JULY" | "AUGUST" | "SEPTEMBER" | "OCTOBER" | "NOVEMBER" | "DECEMBER" }
export const EstimateResetDto = Schema.Struct({ "dayOfMonth": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt())), "dayOfWeek": Schema.optionalKey(Schema.Literals(["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"])), "hour": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt())), "interval": Schema.optionalKey(Schema.Literals(["WEEKLY", "MONTHLY", "YEARLY"])), "month": Schema.optionalKey(Schema.Literals(["JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE", "JULY", "AUGUST", "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER"])) }).annotate({ "description": "Represents project estimate reset object" })
export type EstimateResetRequest = { readonly "active"?: boolean, readonly "dayOfMonth"?: number, readonly "dayOfWeek"?: "MONDAY" | "TUESDAY" | "WEDNESDAY" | "THURSDAY" | "FRIDAY" | "SATURDAY" | "SUNDAY", readonly "hour"?: number, readonly "interval"?: "WEEKLY" | "MONTHLY" | "YEARLY", readonly "isActive"?: boolean, readonly "month"?: "JANUARY" | "FEBRUARY" | "MARCH" | "APRIL" | "MAY" | "JUNE" | "JULY" | "AUGUST" | "SEPTEMBER" | "OCTOBER" | "NOVEMBER" | "DECEMBER" }
export const EstimateResetRequest = Schema.Struct({ "active": Schema.optionalKey(Schema.Boolean), "dayOfMonth": Schema.optionalKey(Schema.Number.annotate({ "description": "Represents a day of the month.", "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(31))), "dayOfWeek": Schema.optionalKey(Schema.Literals(["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"]).annotate({ "description": "Represents a day of the week." })), "hour": Schema.optionalKey(Schema.Number.annotate({ "description": "Represents an hour of the day in 24 hour time format.", "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0)).check(Schema.isLessThanOrEqualTo(23))), "interval": Schema.optionalKey(Schema.Literals(["WEEKLY", "MONTHLY", "YEARLY"]).annotate({ "description": "Represents a reset option enum." })), "isActive": Schema.optionalKey(Schema.Boolean.annotate({ "writeOnly": true })), "month": Schema.optionalKey(Schema.Literals(["JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE", "JULY", "AUGUST", "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER"]).annotate({ "description": "Represents a month enum." })) }).annotate({ "description": "Represents estimate reset request object." })
export type EstimateWithOptionsDto = { readonly "active"?: boolean, readonly "estimate"?: number, readonly "includeExpenses"?: boolean, readonly "resetOption"?: "WEEKLY" | "MONTHLY" | "YEARLY", readonly "type"?: "AUTO" | "MANUAL" }
export const EstimateWithOptionsDto = Schema.Struct({ "active": Schema.optionalKey(Schema.Boolean), "estimate": Schema.optionalKey(Schema.Number.annotate({ "description": "Represents an estimate as long.", "format": "int64" }).check(Schema.isInt())), "includeExpenses": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether estimate includes non-billable or not." })), "resetOption": Schema.optionalKey(Schema.Literals(["WEEKLY", "MONTHLY", "YEARLY"]).annotate({ "description": "Represents a reset option enum." })), "type": Schema.optionalKey(Schema.Literals(["AUTO", "MANUAL"]).annotate({ "description": "Represents an estimate type enum." })) }).annotate({ "description": "Represents a project budget estimate object." })
export type EstimateWithOptionsRequest = { readonly "active"?: boolean, readonly "estimate"?: number, readonly "includeExpenses"?: boolean, readonly "resetOption"?: "WEEKLY" | "MONTHLY" | "YEARLY", readonly "type"?: "AUTO" | "MANUAL" }
export const EstimateWithOptionsRequest = Schema.Struct({ "active": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Flag whether to set estimate as active or not." })), "estimate": Schema.optionalKey(Schema.Number.annotate({ "description": "Represents an estimate as long.", "format": "int64" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0))), "includeExpenses": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Flag whether to include billable expenses." })), "resetOption": Schema.optionalKey(Schema.Literals(["WEEKLY", "MONTHLY", "YEARLY"]).annotate({ "description": "Represents a reset option enum." })), "type": Schema.optionalKey(Schema.Literals(["AUTO", "MANUAL"]).annotate({ "description": "Represents an estimate type enum." })) }).annotate({ "description": "Represents estimate with options request object." })
export type ExpenseCategoryArchiveV1Request = { readonly "archived"?: boolean }
export const ExpenseCategoryArchiveV1Request = Schema.Struct({ "archived": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Flag whether to archive the expense category or not." })) })
export type ExpenseCategoryDto = { readonly "archived"?: boolean, readonly "hasUnitPrice"?: boolean, readonly "id"?: string, readonly "name"?: string, readonly "priceInCents"?: number, readonly "unit"?: string, readonly "workspaceId"?: string }
export const ExpenseCategoryDto = Schema.Struct({ "archived": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Flag that indicates whether the expense category is archived or not." })), "hasUnitPrice": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Represents whether expense category has unit price or none." })), "id": Schema.optionalKey(Schema.String.annotate({ "description": "Represents expense category identifier across the system." })), "name": Schema.optionalKey(Schema.String.annotate({ "description": "Represents expense category name." })), "priceInCents": Schema.optionalKey(Schema.Number.annotate({ "description": "Represents price in cents as integer.", "format": "int32" }).check(Schema.isInt())), "unit": Schema.optionalKey(Schema.String.annotate({ "description": "Represents expense category unit." })), "workspaceId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents workspace identifier across the system." })) }).annotate({ "description": "Represents an expense category object." })
export type ExpenseCategoryDtoV1 = { readonly "archived"?: boolean, readonly "hasUnitPrice"?: boolean, readonly "id"?: string, readonly "name"?: string, readonly "priceInCents"?: number, readonly "unit"?: string, readonly "workspaceId"?: string }
export const ExpenseCategoryDtoV1 = Schema.Struct({ "archived": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Flag that indicates whether the expense category is archived or not." })), "hasUnitPrice": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Represents whether expense category has unit price or none." })), "id": Schema.optionalKey(Schema.String.annotate({ "description": "Represents expense category identifier across the system." })), "name": Schema.optionalKey(Schema.String.annotate({ "description": "Represents expense category name." })), "priceInCents": Schema.optionalKey(Schema.Number.annotate({ "description": "Represents price in cents as integer.", "format": "int32" }).check(Schema.isInt())), "unit": Schema.optionalKey(Schema.String.annotate({ "description": "Represents expense category unit." })), "workspaceId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents workspace identifier across the system." })) }).annotate({ "description": "Represents a list of expense categories data transfer object." })
export type ExpenseCategoryV1Request = { readonly "hasUnitPrice"?: boolean, readonly "name": string, readonly "priceInCents"?: number, readonly "unit"?: string }
export const ExpenseCategoryV1Request = Schema.Struct({ "hasUnitPrice": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Flag whether expense category has unit price or none." })), "name": Schema.String.annotate({ "description": "Represents a valid expense category name." }).check(Schema.isMinLength(0)).check(Schema.isMaxLength(250)), "priceInCents": Schema.optionalKey(Schema.Number.annotate({ "description": "Represents price in cents as integer.", "format": "int32" }).check(Schema.isInt())), "unit": Schema.optionalKey(Schema.String.annotate({ "description": "Represents a valid expense category unit." })) })
export type ExpenseDailyTotalsDtoV1 = { readonly "date"?: string, readonly "dateAsInstant"?: string, readonly "total"?: number }
export const ExpenseDailyTotalsDtoV1 = Schema.Struct({ "date": Schema.optionalKey(Schema.String.annotate({ "description": "Represents a date in yyyy-MM-dd format." })), "dateAsInstant": Schema.optionalKey(Schema.String.annotate({ "format": "date-time" })), "total": Schema.optionalKey(Schema.Number.annotate({ "description": "Represents expense total.", "format": "double" }).check(Schema.isFinite())) }).annotate({ "description": "Represents a list of expense daily total data transfer objects." })
export type ExpenseDtoV1 = { readonly "billable"?: boolean, readonly "categoryId"?: string, readonly "date"?: string, readonly "fileId"?: string, readonly "id"?: string, readonly "isLocked"?: boolean, readonly "locked"?: boolean, readonly "notes"?: string, readonly "projectId"?: string, readonly "quantity"?: number, readonly "taskId"?: string, readonly "total"?: number, readonly "userId"?: string, readonly "workspaceId"?: string }
export const ExpenseDtoV1 = Schema.Struct({ "billable": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether expense is billable or not." })), "categoryId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents category identifier across the system." })), "date": Schema.optionalKey(Schema.String.annotate({ "description": "Represents a date in yyyy-MM-dd format." })), "fileId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents file identifier across the system." })), "id": Schema.optionalKey(Schema.String.annotate({ "description": "Represents expense identifier across the system." })), "isLocked": Schema.optionalKey(Schema.Boolean.annotate({ "writeOnly": true })), "locked": Schema.optionalKey(Schema.Boolean), "notes": Schema.optionalKey(Schema.String.annotate({ "description": "Represents notes for an expense." })), "projectId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents project identifier across the system." })), "quantity": Schema.optionalKey(Schema.Number.annotate({ "description": "Represents expense quantity as double data type.", "format": "double" }).check(Schema.isFinite())), "taskId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents task identifier across the system." })), "total": Schema.optionalKey(Schema.Number.annotate({ "description": "Represents expense total as double data type.", "format": "double" }).check(Schema.isFinite())), "userId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents user identifier across the system." })), "workspaceId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents workspace identifier across the system." })) })
export type ExpenseWeeklyTotalsDtoV1 = { readonly "date"?: string, readonly "total"?: number }
export const ExpenseWeeklyTotalsDtoV1 = Schema.Struct({ "date": Schema.optionalKey(Schema.String.annotate({ "description": "Represents a date in yyyy-MM-dd format." })), "total": Schema.optionalKey(Schema.Number.annotate({ "description": "Represents expense total.", "format": "double" }).check(Schema.isFinite())) }).annotate({ "description": "Represents a list of expense weekly total data transfer objects." })
export type Feature = never
export const Feature = Schema.Never
export type FeaturePlan = never
export const FeaturePlan = Schema.Never
export type GetTimeOffRequestsV1Request = { readonly "end"?: string, readonly "page"?: number, readonly "pageSize"?: number, readonly "start"?: string, readonly "statuses"?: ReadonlyArray<"PENDING" | "APPROVED" | "REJECTED" | "ALL">, readonly "userGroups"?: ReadonlyArray<string>, readonly "users"?: ReadonlyArray<string> }
export const GetTimeOffRequestsV1Request = Schema.Struct({ "end": Schema.optionalKey(Schema.String.annotate({ "description": "Provide the end of the filtering period. Used with `start` to filter for time-off requests periods that occur (fully or partially) within this range. Both parameters must be provided for filtering to take effect. Provide end in format YYYY-MM-DDTHH:MM:SS.ssssssZ", "format": "date-time" })), "page": Schema.optionalKey(Schema.Number.annotate({ "description": "Page number.", "format": "int32" }).check(Schema.isInt()).check(Schema.isLessThanOrEqualTo(1000))), "pageSize": Schema.optionalKey(Schema.Number.annotate({ "description": "Page size.", "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(200))), "start": Schema.optionalKey(Schema.String.annotate({ "description": "Provide the beginning of the filtering period. Used with `end` to filter for time-off requests periods that occur (fully or partially) within this range. Both parameters must be provided for filtering to take effect. Provide start in format YYYY-MM-DDTHH:MM:SS.ssssssZ", "format": "date-time" })), "statuses": Schema.optionalKey(Schema.Array(Schema.Literals(["PENDING", "APPROVED", "REJECTED", "ALL"]).annotate({ "description": "Filters time off requests by status." })).annotate({ "description": "Filters time off requests by status." }).check(Schema.isUnique())), "userGroups": Schema.optionalKey(Schema.Array(Schema.String.annotate({ "description": "Provide the user group ids of time off requests." })).annotate({ "description": "Provide the user group ids of time off requests." }).check(Schema.isUnique())), "users": Schema.optionalKey(Schema.Array(Schema.String.annotate({ "description": "Provide the user ids of time off requests. If empty, will return time off requests of all users (with a maximum of 5000 users)." })).annotate({ "description": "Provide the user ids of time off requests. If empty, will return time off requests of all users (with a maximum of 5000 users)." }).check(Schema.isUnique())) })
export type GetUsersRequestV1 = { readonly "accountStatuses"?: ReadonlyArray<string>, readonly "email"?: string, readonly "includeRoles"?: boolean, readonly "memberships"?: "ALL" | "NONE" | "WORKSPACE" | "PROJECT" | "USERGROUP", readonly "name"?: string, readonly "page"?: number, readonly "pageSize"?: number, readonly "projectId"?: string, readonly "roles"?: ReadonlyArray<"WORKSPACE_ADMIN" | "OWNER" | "TEAM_MANAGER" | "PROJECT_MANAGER">, readonly "sortColumn"?: "ID" | "EMAIL" | "NAME" | "NAME_LOWERCASE" | "ACCESS" | "HOURLYRATE" | "COSTRATE", readonly "sortOrder"?: "ASCENDING" | "DESCENDING", readonly "status"?: "PENDING" | "ACTIVE" | "DECLINED" | "INACTIVE" | "ALL", readonly "userGroups"?: ReadonlyArray<string> }
export const GetUsersRequestV1 = Schema.Struct({ "accountStatuses": Schema.optionalKey(Schema.Array(Schema.String.annotate({ "description": "If provided, you'll get a filtered list of users with the corresponding account status filter. If not, this will only filter ACTIVE, PENDING_EMAIL_VERIFICATION, and NOT_REGISTERED Users." })).annotate({ "description": "If provided, you'll get a filtered list of users with the corresponding account status filter. If not, this will only filter ACTIVE, PENDING_EMAIL_VERIFICATION, and NOT_REGISTERED Users." }).check(Schema.isUnique())), "email": Schema.optionalKey(Schema.String.annotate({ "description": "If provided, you'll get a filtered list of users that contain the provided string in their email address." })), "includeRoles": Schema.optionalKey(Schema.Boolean.annotate({ "description": "If you pass along includeRoles=true, you'll get each user's detailed manager role (including projects and members for whom they're managers)" })), "memberships": Schema.optionalKey(Schema.Literals(["ALL", "NONE", "WORKSPACE", "PROJECT", "USERGROUP"]).annotate({ "description": "If provided, you'll get all users along with workspaces, groups, or projects they have access to." })), "name": Schema.optionalKey(Schema.String.annotate({ "description": "If provided, you'll get a filtered list of users that contain the provided string in their name." })), "page": Schema.optionalKey(Schema.Number.annotate({ "description": "Page number.", "format": "int32" }).check(Schema.isInt())), "pageSize": Schema.optionalKey(Schema.Number.annotate({ "description": "Page size.", "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1))), "projectId": Schema.optionalKey(Schema.String.annotate({ "description": "If provided, you'll get a list of users that have access to the project." })), "roles": Schema.optionalKey(Schema.Array(Schema.Literals(["WORKSPACE_ADMIN", "OWNER", "TEAM_MANAGER", "PROJECT_MANAGER"]).annotate({ "description": "If provided, you'll get a filtered list of users that have any of the specified roles. Owners are counted as admins when filtering." })).annotate({ "description": "If provided, you'll get a filtered list of users that have any of the specified roles. Owners are counted as admins when filtering." }).check(Schema.isUnique())), "sortColumn": Schema.optionalKey(Schema.Literals(["ID", "EMAIL", "NAME", "NAME_LOWERCASE", "ACCESS", "HOURLYRATE", "COSTRATE"]).annotate({ "description": "Sorting criteria" })), "sortOrder": Schema.optionalKey(Schema.Literals(["ASCENDING", "DESCENDING"]).annotate({ "description": "Sorting mode" })), "status": Schema.optionalKey(Schema.Literals(["PENDING", "ACTIVE", "DECLINED", "INACTIVE", "ALL"]).annotate({ "description": "If provided, you'll get a filtered list of users with the corresponding status." })), "userGroups": Schema.optionalKey(Schema.Array(Schema.String.annotate({ "description": "If provided, you'll get a list of users that belong to the specified user group IDs." })).annotate({ "description": "If provided, you'll get a list of users that belong to the specified user group IDs." }).check(Schema.isUnique())) })
export type HourlyRateDtoV1 = { readonly "amount"?: number, readonly "currency"?: string }
export const HourlyRateDtoV1 = Schema.Struct({ "amount": Schema.optionalKey(Schema.Number.annotate({ "description": "Represents an amount as integer.", "format": "int32" }).check(Schema.isInt())), "currency": Schema.optionalKey(Schema.String.annotate({ "description": "Represents a currency." })) }).annotate({ "description": "Represents an hourly rate object." })
export type HourlyRateRequest = { readonly "amount": number, readonly "since"?: string }
export const HourlyRateRequest = Schema.Struct({ "amount": Schema.Number.annotate({ "description": "Represents a cost rate amount as integer.", "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0)), "since": Schema.optionalKey(Schema.String.annotate({ "description": "Represents a datetime in yyyy-MM-ddThh:mm:ssZ format." })) }).annotate({ "description": "Represents an hourly rate request object." })
export type HourlyRateRequestV1 = { readonly "amount": number, readonly "since"?: string }
export const HourlyRateRequestV1 = Schema.Struct({ "amount": Schema.Number.annotate({ "description": "Represents an hourly rate amount as integer.", "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0)), "since": Schema.optionalKey(Schema.String.annotate({ "description": "Represents a date and time in yyyy-MM-ddThh:mm:ssZ format." })) })
export type InvoiceDefaultSettingsDto = { readonly "companyId"?: string, readonly "defaultImportExpenseItemTypeId"?: string, readonly "defaultImportTimeItemTypeId"?: string, readonly "dueDays"?: number, readonly "itemType"?: string, readonly "itemTypeId"?: string, readonly "notes"?: string, readonly "subject"?: string, readonly "tax"?: number, readonly "tax2"?: number, readonly "tax2Percent"?: number, readonly "taxPercent"?: number, readonly "taxType"?: "COMPOUND" | "SIMPLE" | "NONE" }
export const InvoiceDefaultSettingsDto = Schema.Struct({ "companyId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents company identifier across the system." })), "defaultImportExpenseItemTypeId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents item type identifier across the system." })), "defaultImportTimeItemTypeId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents item type identifier across the system." })), "dueDays": Schema.optionalKey(Schema.Number.annotate({ "description": "Represents an invoice number of due days.", "format": "int32" }).check(Schema.isInt())), "itemType": Schema.optionalKey(Schema.String.annotate({ "writeOnly": true })), "itemTypeId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents item type identifier across the system." })), "notes": Schema.optionalKey(Schema.String.annotate({ "description": "Represents an invoice note." })), "subject": Schema.optionalKey(Schema.String.annotate({ "description": "Represents an invoice subject." })), "tax": Schema.optionalKey(Schema.Number.annotate({ "format": "int64" }).check(Schema.isInt())), "tax2": Schema.optionalKey(Schema.Number.annotate({ "format": "int64" }).check(Schema.isInt())), "tax2Percent": Schema.optionalKey(Schema.Number.annotate({ "description": "Represents a tax amount in percentage.", "format": "double" }).check(Schema.isFinite())), "taxPercent": Schema.optionalKey(Schema.Number.annotate({ "description": "Represents a tax amount in percentage.", "format": "double" }).check(Schema.isFinite())), "taxType": Schema.optionalKey(Schema.Literals(["COMPOUND", "SIMPLE", "NONE"]).annotate({ "description": "Represents a tax type." })) }).annotate({ "description": "Represents an invoice default settings object." })
export type InvoiceDefaultSettingsRequestV1 = { readonly "companyId"?: string, readonly "dueDays"?: number, readonly "itemTypeId"?: string, readonly "notes": string, readonly "subject": string, readonly "tax2Percent"?: number, readonly "taxPercent"?: number, readonly "taxType"?: "COMPOUND" | "SIMPLE" | "NONE" }
export const InvoiceDefaultSettingsRequestV1 = Schema.Struct({ "companyId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents company identifier across the system." })), "dueDays": Schema.optionalKey(Schema.Number.annotate({ "description": "Represents an invoice number of due days.", "format": "int32" }).check(Schema.isInt())), "itemTypeId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents item type identifier across the system." })), "notes": Schema.String.annotate({ "description": "Represents an invoice note." }), "subject": Schema.String.annotate({ "description": "Represents an invoice subject." }), "tax2Percent": Schema.optionalKey(Schema.Number.annotate({ "description": "Represents a tax amount in percentage.", "format": "double" }).check(Schema.isFinite())), "taxPercent": Schema.optionalKey(Schema.Number.annotate({ "description": "Represents a tax amount in percentage.", "format": "double" }).check(Schema.isFinite())), "taxType": Schema.optionalKey(Schema.Literals(["COMPOUND", "SIMPLE", "NONE"]).annotate({ "description": "Represents a tax type." })) }).annotate({ "description": "Represents an invoice default settings object." })
export type InvoiceDtoV1 = { readonly "amount"?: number, readonly "balance"?: number, readonly "clientId"?: string, readonly "clientName"?: string, readonly "currency"?: string, readonly "dueDate"?: string, readonly "id"?: string, readonly "issuedDate"?: string, readonly "number"?: string, readonly "paid"?: number, readonly "status"?: "UNSENT" | "SENT" | "PAID" | "PARTIALLY_PAID" | "VOID" | "OVERDUE" }
export const InvoiceDtoV1 = Schema.Struct({ "amount": Schema.optionalKey(Schema.Number.annotate({ "description": "Represents an invoice amount as long.", "format": "int64" }).check(Schema.isInt())), "balance": Schema.optionalKey(Schema.Number.annotate({ "description": "Represents an invoice balance amount as long.", "format": "int64" }).check(Schema.isInt())), "clientId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents client identifier across the system." })), "clientName": Schema.optionalKey(Schema.String.annotate({ "description": "Represents client name for an invoice." })), "currency": Schema.optionalKey(Schema.String.annotate({ "description": "Represents the currency used by the invoice." })), "dueDate": Schema.optionalKey(Schema.String.annotate({ "description": "Represents an invoice due date in yyyy-MM-ddThh:mm:ssZ format.", "format": "date-time" })), "id": Schema.optionalKey(Schema.String.annotate({ "description": "Represents invoice identifier across the system." })), "issuedDate": Schema.optionalKey(Schema.String.annotate({ "description": "Represents an invoice issued date in yyyy-MM-ddThh:mm:ssZ format.", "format": "date-time" })), "number": Schema.optionalKey(Schema.String.annotate({ "description": "Represents an invoice number." })), "paid": Schema.optionalKey(Schema.Number.annotate({ "description": "Represents an invoice paid amount as long.", "format": "int64" }).check(Schema.isInt())), "status": Schema.optionalKey(Schema.Literals(["UNSENT", "SENT", "PAID", "PARTIALLY_PAID", "VOID", "OVERDUE"]).annotate({ "description": "Represents the status of an invoice." })) }).annotate({ "description": "Represents a list of invoices." })
export type InvoiceExportFields = { readonly "RTL"?: boolean, readonly "itemType"?: boolean, readonly "quantity"?: boolean, readonly "rtl"?: boolean, readonly "tax"?: boolean, readonly "tax2"?: boolean, readonly "unitPrice"?: boolean }
export const InvoiceExportFields = Schema.Struct({ "RTL": Schema.optionalKey(Schema.Boolean.annotate({ "writeOnly": true })), "itemType": Schema.optionalKey(Schema.Boolean), "quantity": Schema.optionalKey(Schema.Boolean), "rtl": Schema.optionalKey(Schema.Boolean), "tax": Schema.optionalKey(Schema.Boolean), "tax2": Schema.optionalKey(Schema.Boolean), "unitPrice": Schema.optionalKey(Schema.Boolean) }).annotate({ "description": "Represents an invoice export fields object." })
export type InvoiceExportFieldsRequest = { readonly "itemType"?: boolean, readonly "quantity"?: boolean, readonly "rtl"?: boolean, readonly "tax"?: boolean, readonly "tax2"?: boolean, readonly "unitPrice"?: boolean }
export const InvoiceExportFieldsRequest = Schema.Struct({ "itemType": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether to export item type." })), "quantity": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether to export quantity." })), "rtl": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether to export RTL." })), "tax": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether to export tax." })), "tax2": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether to export tax2." })), "unitPrice": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether to export unit price." })) }).annotate({ "description": "Represents an invoice export fields object." })
export type InvoicePaymentDtoV1 = { readonly "amount"?: number, readonly "author"?: string, readonly "date"?: string, readonly "id"?: string, readonly "note"?: string }
export const InvoicePaymentDtoV1 = Schema.Struct({ "amount": Schema.optionalKey(Schema.Number.annotate({ "description": "Represents an invoice payment amount as long.", "format": "int64" }).check(Schema.isInt())), "author": Schema.optionalKey(Schema.String.annotate({ "description": "Represents an invoice payment author." })), "date": Schema.optionalKey(Schema.String.annotate({ "description": "Represents an invoice payment date in yyyy-MM-ddThh:mm:ssZ format.", "format": "date-time" })), "id": Schema.optionalKey(Schema.String.annotate({ "description": "Represents invoice payment identifier across the system." })), "note": Schema.optionalKey(Schema.String.annotate({ "description": "Represents an invoice payment note." })) })
export type LabelsCustomization = { readonly "amount"?: string, readonly "billFrom"?: string, readonly "billTo"?: string, readonly "description"?: string, readonly "discount"?: string, readonly "dueDate"?: string, readonly "issueDate"?: string, readonly "itemType"?: string, readonly "notes"?: string, readonly "paid"?: string, readonly "quantity"?: string, readonly "subtotal"?: string, readonly "tax"?: string, readonly "tax2"?: string, readonly "total"?: string, readonly "totalAmount"?: string, readonly "unitPrice"?: string }
export const LabelsCustomization = Schema.Struct({ "amount": Schema.optionalKey(Schema.String.annotate({ "description": "Represents invoice amount." })), "billFrom": Schema.optionalKey(Schema.String.annotate({ "description": "Represents a string an invoice is billed from." })), "billTo": Schema.optionalKey(Schema.String.annotate({ "description": "Represents a string an invoice is billed to." })), "description": Schema.optionalKey(Schema.String.annotate({ "description": "Represents a description of an invoice." })), "discount": Schema.optionalKey(Schema.String.annotate({ "description": "Represents invoice discount amount." })), "dueDate": Schema.optionalKey(Schema.String.annotate({ "description": "Represents a due date in yyyy-MM-dd format." })), "issueDate": Schema.optionalKey(Schema.String.annotate({ "description": "Represents an issue date in yyyy-MM-dd format." })), "itemType": Schema.optionalKey(Schema.String.annotate({ "description": "Represents an item type." })), "notes": Schema.optionalKey(Schema.String.annotate({ "description": "Represents notes for an invoice." })), "paid": Schema.optionalKey(Schema.String.annotate({ "description": "Represents invoice paid amount." })), "quantity": Schema.optionalKey(Schema.String.annotate({ "description": "Represents quantity." })), "subtotal": Schema.optionalKey(Schema.String.annotate({ "description": "Represents invoice subtotal." })), "tax": Schema.optionalKey(Schema.String.annotate({ "description": "Represents invoice tax amount." })), "tax2": Schema.optionalKey(Schema.String.annotate({ "description": "Represents invoice tax amount." })), "total": Schema.optionalKey(Schema.String.annotate({ "description": "Represents invoice total amount." })), "totalAmount": Schema.optionalKey(Schema.String.annotate({ "description": "Represents invoice total amount." })), "unitPrice": Schema.optionalKey(Schema.String.annotate({ "description": "Represents unit price." })) }).annotate({ "description": "Represents a label customization object." })
export type LabelsCustomizationRequest = { readonly "amount": string, readonly "billFrom": string, readonly "billTo": string, readonly "description": string, readonly "discount": string, readonly "dueDate": string, readonly "issueDate": string, readonly "itemType": string, readonly "notes": string, readonly "paid": string, readonly "quantity": string, readonly "subtotal": string, readonly "tax": string, readonly "tax2": string, readonly "total": string, readonly "totalAmountDue": string, readonly "unitPrice": string }
export const LabelsCustomizationRequest = Schema.Struct({ "amount": Schema.String.annotate({ "description": "Represents invoice amount label." }).check(Schema.isMinLength(0)).check(Schema.isMaxLength(20)), "billFrom": Schema.String.annotate({ "description": "Represents invoice bill from label." }).check(Schema.isMinLength(0)).check(Schema.isMaxLength(20)), "billTo": Schema.String.annotate({ "description": "Represents invoice bill to label." }).check(Schema.isMinLength(0)).check(Schema.isMaxLength(20)), "description": Schema.String.annotate({ "description": "Represents invoice description label." }).check(Schema.isMinLength(0)).check(Schema.isMaxLength(20)), "discount": Schema.String.annotate({ "description": "Represents invoice discount amount label." }).check(Schema.isMinLength(0)).check(Schema.isMaxLength(20)), "dueDate": Schema.String.annotate({ "description": "Represents invoice due date label." }).check(Schema.isMinLength(0)).check(Schema.isMaxLength(20)), "issueDate": Schema.String.annotate({ "description": "Represents invoice issue date label." }).check(Schema.isMinLength(0)).check(Schema.isMaxLength(20)), "itemType": Schema.String.annotate({ "description": "Represents invoice item type label." }).check(Schema.isMinLength(0)).check(Schema.isMaxLength(20)), "notes": Schema.String.annotate({ "description": "Represents invoice notes label." }).check(Schema.isMinLength(0)).check(Schema.isMaxLength(20)), "paid": Schema.String.annotate({ "description": "Represents invoice paid amount label." }).check(Schema.isMinLength(0)).check(Schema.isMaxLength(20)), "quantity": Schema.String.annotate({ "description": "Represents invoice quantity label." }).check(Schema.isMinLength(0)).check(Schema.isMaxLength(20)), "subtotal": Schema.String.annotate({ "description": "Represents invoice subtotal label." }).check(Schema.isMinLength(0)).check(Schema.isMaxLength(20)), "tax": Schema.String.annotate({ "description": "Represents invoice tax amount label." }).check(Schema.isMinLength(0)).check(Schema.isMaxLength(20)), "tax2": Schema.String.annotate({ "description": "Represents invoice tax 2 amount label." }).check(Schema.isMinLength(0)).check(Schema.isMaxLength(20)), "total": Schema.String.annotate({ "description": "Represents invoice total amount label." }).check(Schema.isMinLength(0)).check(Schema.isMaxLength(20)), "totalAmountDue": Schema.String.annotate({ "description": "Represents invoice total amount due label." }).check(Schema.isMinLength(0)).check(Schema.isMaxLength(20)), "unitPrice": Schema.String.annotate({ "description": "Represents invoice unit price label." }).check(Schema.isMinLength(0)).check(Schema.isMaxLength(20)) }).annotate({ "description": "Represents a label customization object." })
export type LogBinDocumentDto = { readonly "deletedAt"?: string, readonly "document"?: {  }, readonly "documentCode"?: string, readonly "id"?: string }
export const LogBinDocumentDto = Schema.Struct({ "deletedAt": Schema.optionalKey(Schema.String.annotate({ "format": "date-time" })), "document": Schema.optionalKey(Schema.Struct({  })), "documentCode": Schema.optionalKey(Schema.String), "id": Schema.optionalKey(Schema.String) })
export type MilestoneDto = { readonly "date"?: string, readonly "id"?: string, readonly "name"?: string, readonly "projectId"?: string, readonly "workspaceId"?: string }
export const MilestoneDto = Schema.Struct({ "date": Schema.optionalKey(Schema.String.annotate({ "description": "Represents a date in yyyy-MM-ddThh:mm:ssZ format.", "format": "date-time" })), "id": Schema.optionalKey(Schema.String.annotate({ "description": "Represents milestone identifier across the system." })), "name": Schema.optionalKey(Schema.String.annotate({ "description": "Represents milestone name." })), "projectId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents project identifier across the system." })), "workspaceId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents workspace identifier across the system." })) }).annotate({ "description": "Represents a list of milestone objects." })
export type NegativeBalanceDto = { readonly "amount"?: number, readonly "period"?: string, readonly "shouldReset"?: boolean, readonly "timeUnit"?: string }
export const NegativeBalanceDto = Schema.Struct({ "amount": Schema.optionalKey(Schema.Number.annotate({ "format": "double" }).check(Schema.isFinite())), "period": Schema.optionalKey(Schema.String), "shouldReset": Schema.optionalKey(Schema.Boolean), "timeUnit": Schema.optionalKey(Schema.String) }).annotate({ "description": "Represents the data about negative balance including amount, time unit and period." })
export type NegativeBalanceRequest = { readonly "amount": number, readonly "period"?: "MONTH" | "YEAR", readonly "shouldReset"?: boolean }
export const NegativeBalanceRequest = Schema.Struct({ "amount": Schema.Number.annotate({ "description": "Represents negative balance amount.", "format": "double" }).check(Schema.isFinite()).check(Schema.isGreaterThanOrEqualTo(0)), "period": Schema.optionalKey(Schema.Literals(["MONTH", "YEAR"]).annotate({ "description": "Represents negative balance period." })), "shouldReset": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether negative balance should be reset at the end of the negative balance period." })) }).annotate({ "description": "Provide the negative balance data you would like to use for updating the policy." })
export type PatchProjectTemplateRequest = { readonly "isTemplate"?: boolean }
export const PatchProjectTemplateRequest = Schema.Struct({ "isTemplate": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether project is a template or not." })) })
export type Period = { readonly "end"?: string, readonly "start"?: string }
export const Period = Schema.Struct({ "end": Schema.optionalKey(Schema.String.annotate({ "format": "date-time" })), "start": Schema.optionalKey(Schema.String.annotate({ "format": "date-time" })) })
export type PeriodV1Request = { readonly "days"?: number, readonly "end"?: string, readonly "start"?: string }
export const PeriodV1Request = Schema.Struct({ "days": Schema.optionalKey(Schema.Number.annotate({ "description": "Provide number of days.", "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(999))), "end": Schema.optionalKey(Schema.String.annotate({ "description": "Provide end date in YYYY-MM-DD format." })), "start": Schema.optionalKey(Schema.String.annotate({ "description": "Provide start date in YYYY-MM-DD format." })) }).annotate({ "description": "Represents period of time off request including start and end date." })
export type PolicyApprovalDto = { readonly "requiresApproval"?: boolean, readonly "specificMembers"?: boolean, readonly "teamManagers"?: boolean, readonly "userIds"?: ReadonlyArray<string> }
export const PolicyApprovalDto = Schema.Struct({ "requiresApproval": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether it requires approval" })), "specificMembers": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether it requires specific members" })), "teamManagers": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether it requires team manager's approval" })), "userIds": Schema.optionalKey(Schema.Array(Schema.String.annotate({ "description": "Represents set of user's identifier across the system" })).annotate({ "description": "Represents set of user's identifier across the system" }).check(Schema.isUnique())) }).annotate({ "description": "Represents approval settings." })
export type ProjectInfoDto = { readonly "clientId"?: string, readonly "clientName"?: string, readonly "color"?: string, readonly "id"?: string, readonly "name"?: string }
export const ProjectInfoDto = Schema.Struct({ "clientId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents client identifier across the system." })), "clientName": Schema.optionalKey(Schema.String.annotate({ "description": "Represents client name." })), "color": Schema.optionalKey(Schema.String.annotate({ "description": "Color format ^#(?:[0-9a-fA-F]{6}){1}$. Explanation: A valid color code should start with '#' and consist of six hexadecimal characters, representing a color in hexadecimal format. Color value is in standard RGB hexadecimal format." })), "id": Schema.optionalKey(Schema.String.annotate({ "description": "Represents project identifier across the system." })), "name": Schema.optionalKey(Schema.String.annotate({ "description": "Represents a project name." })) }).annotate({ "description": "Represents a project info object." })
export type ProjectTaskTupleDto = { readonly "projectId"?: string, readonly "taskId"?: string }
export const ProjectTaskTupleDto = Schema.Struct({ "projectId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents a project identifier across the system." })), "taskId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents a task identifier across the system." })) }).annotate({ "description": "Represents a list of template's projects and tasks." })
export type ProjectTaskTupleRequest = { readonly "projectId": string, readonly "taskId"?: string, readonly "type"?: string }
export const ProjectTaskTupleRequest = Schema.Struct({ "projectId": Schema.String.annotate({ "description": "Represents a project identifier across the system." }).check(Schema.isMinLength(1)), "taskId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents a task identifier across the system." })), "type": Schema.optionalKey(Schema.String.annotate({ "description": "Represents a time entry type." })) }).annotate({ "description": "Represents a list of template's projects and tasks." })
export type ProjectTotalsRequestV1 = { readonly "end": string, readonly "page"?: number, readonly "pageSize"?: number, readonly "search"?: string, readonly "start": string, readonly "statusFilter"?: "PUBLISHED" | "UNPUBLISHED" | "ALL" }
export const ProjectTotalsRequestV1 = Schema.Struct({ "end": Schema.String.annotate({ "description": "Represents an end date in the yyyy-MM-ddThh:mm:ssZ format.", "format": "date-time" }), "page": Schema.optionalKey(Schema.Number.annotate({ "description": "Page number.", "format": "int32" }).check(Schema.isInt())), "pageSize": Schema.optionalKey(Schema.Number.annotate({ "description": "Page size.", "format": "int32" }).check(Schema.isInt()).check(Schema.isLessThanOrEqualTo(200))), "search": Schema.optionalKey(Schema.String.annotate({ "description": "Represents a term for searching projects and clients by name." })), "start": Schema.String.annotate({ "description": "Represents a start date in the yyyy-MM-ddThh:mm:ssZ format.", "format": "date-time" }), "statusFilter": Schema.optionalKey(Schema.Literals(["PUBLISHED", "UNPUBLISHED", "ALL"]).annotate({ "description": "Filters assignments by status." })) })
export type RateDto = { readonly "amount"?: number, readonly "currency"?: string }
export const RateDto = Schema.Struct({ "amount": Schema.optionalKey(Schema.Number.annotate({ "description": "Represents an amount as integer.", "format": "int32" }).check(Schema.isInt())), "currency": Schema.optionalKey(Schema.String.annotate({ "description": "Represents a currency." })) }).annotate({ "description": "Represents cost rate object." })
export type RateDtoV1 = { readonly "amount"?: number, readonly "currency"?: string }
export const RateDtoV1 = Schema.Struct({ "amount": Schema.optionalKey(Schema.Number.annotate({ "description": "Represents an amount as integer.", "format": "int32" }).check(Schema.isInt())), "currency": Schema.optionalKey(Schema.String.annotate({ "description": "Represents a currency." })) }).annotate({ "description": "Represents cost rate object." })
export type RateWithCurrencyRequestV1 = { readonly "amount": number, readonly "currency": string, readonly "since"?: string }
export const RateWithCurrencyRequestV1 = Schema.Struct({ "amount": Schema.Number.annotate({ "description": "Represents an amount as integer.", "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0)), "currency": Schema.String.annotate({ "description": "Represents a currency." }).check(Schema.isMinLength(1)).check(Schema.isMaxLength(100)), "since": Schema.optionalKey(Schema.String.annotate({ "description": "Represents a date and time in yyyy-MM-ddThh:mm:ssZ format." })) })
export type RecurringAssignmentDto = { readonly "repeat"?: boolean, readonly "seriesId"?: string, readonly "weeks"?: number }
export const RecurringAssignmentDto = Schema.Struct({ "repeat": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether assignment is recurring or not." })), "seriesId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents series identifier." })), "weeks": Schema.optionalKey(Schema.Number.annotate({ "description": "Represents number of weeks for thhis assignment.", "format": "int32" }).check(Schema.isInt())) }).annotate({ "description": "Represents recurring assignment object." })
export type RecurringAssignmentRequestV1 = { readonly "repeat"?: boolean, readonly "weeks": number }
export const RecurringAssignmentRequestV1 = Schema.Struct({ "repeat": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether assignment is recurring or not." })), "weeks": Schema.Number.annotate({ "description": "Indicates number of weeks for assignment.", "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(99)) })
export type RoleRequestV1 = { readonly "entityId": string, readonly "role": "WORKSPACE_ADMIN" | "TEAM_MANAGER" | "PROJECT_MANAGER", readonly "sourceType"?: "USER_GROUP" }
export const RoleRequestV1 = Schema.Struct({ "entityId": Schema.String.annotate({ "description": "Represents an entity identifier across the system." }).check(Schema.isMinLength(1)), "role": Schema.Literals(["WORKSPACE_ADMIN", "TEAM_MANAGER", "PROJECT_MANAGER"]).annotate({ "description": "Represents a valid role." }), "sourceType": Schema.optionalKey(Schema.Literal("USER_GROUP").annotate({ "description": "Optional field used to indicate that the target of the operation is a\nuser group, in which case the value USER_GROUP should be used, alongside a valid user group\nID for the entityId field. If omitted, a user ID should be used for the entityId field.\n" })) })
export type RoundDto = { readonly "minutes"?: string, readonly "round"?: string }
export const RoundDto = Schema.Struct({ "minutes": Schema.optionalKey(Schema.String), "round": Schema.optionalKey(Schema.String) }).annotate({ "description": "Represents a time rounding object." })
export type SchedulingExcludeDay = { readonly "date"?: string, readonly "type"?: "WEEKEND" | "HOLIDAY" | "TIME_OFF" }
export const SchedulingExcludeDay = Schema.Struct({ "date": Schema.optionalKey(Schema.String.annotate({ "description": "Represents a datetimr in yyyy-MM-ddThh:mm:ssZ format.", "format": "date-time" })), "type": Schema.optionalKey(Schema.Literals(["WEEKEND", "HOLIDAY", "TIME_OFF"]).annotate({ "description": "Represents the scheduling exclude day enum." })) }).annotate({ "description": "Represents a list of excluded days objects" })
export type StatusTimeOffRequestV1Request = { readonly "note"?: string, readonly "status"?: "APPROVED" | "REJECTED" }
export const StatusTimeOffRequestV1Request = Schema.Struct({ "note": Schema.optionalKey(Schema.String.annotate({ "description": "Provide the note you would like to use for changing the time off request." })), "status": Schema.optionalKey(Schema.Literals(["APPROVED", "REJECTED"]).annotate({ "description": "Provide the status you would like to use for changing the time off request." })) })
export type StopTimeEntryRequest = { readonly "end": string }
export const StopTimeEntryRequest = Schema.Struct({ "end": Schema.String.annotate({ "description": "Represents an end date in the yyyy-MM-ddThh:mm:ssZ format.", "format": "date-time" }) })
export type SummaryReportSettingsDtoV1 = { readonly "group": string, readonly "subgroup": string }
export const SummaryReportSettingsDtoV1 = Schema.Struct({ "group": Schema.String.check(Schema.isMinLength(1)), "subgroup": Schema.String.check(Schema.isMinLength(1)) }).annotate({ "description": "Represents a summary report settings object." })
export type TagDto = { readonly "archived": boolean, readonly "id": string, readonly "name": string, readonly "workspaceId": string }
export const TagDto = Schema.Struct({ "archived": Schema.Boolean.annotate({ "description": "Indicates whether tag is archived or not." }), "id": Schema.String.annotate({ "description": "Represents tag identifier across the system." }), "name": Schema.String.annotate({ "description": "Represents tag name." }), "workspaceId": Schema.String.annotate({ "description": "Represents workspace identifier across the system." }) }).annotate({ "description": "Represents a list of tag objects." })
export type TagDtoV1 = { readonly "archived": boolean, readonly "id": string, readonly "name": string, readonly "workspaceId": string }
export const TagDtoV1 = Schema.Struct({ "archived": Schema.Boolean.annotate({ "description": "Indicates whether a tag is archived or not." }), "id": Schema.String.annotate({ "description": "Represents tag identifier across the system." }), "name": Schema.String.annotate({ "description": "Represents tag name." }), "workspaceId": Schema.String.annotate({ "description": "Represents workspace identifier across the system." }) })
export type TagRequest = { readonly "name"?: string }
export const TagRequest = Schema.Struct({ "name": Schema.optionalKey(Schema.String.annotate({ "description": "Represents a tag name." }).check(Schema.isMinLength(0)).check(Schema.isMaxLength(100))) })
export type TaskInfoDto = { readonly "id"?: string, readonly "name"?: string }
export const TaskInfoDto = Schema.Struct({ "id": Schema.optionalKey(Schema.String.annotate({ "description": "Represents task identifier across the system." })), "name": Schema.optionalKey(Schema.String.annotate({ "description": "Represents task name." })) }).annotate({ "description": "Represents a project info object." })
export type TaskRequestV1 = { readonly "assigneeId"?: string, readonly "assigneeIds"?: ReadonlyArray<string>, readonly "budgetEstimate"?: number, readonly "estimate"?: string, readonly "id"?: string, readonly "name": string, readonly "status"?: "ACTIVE" | "DONE" | "ALL", readonly "userGroupIds"?: ReadonlyArray<string> }
export const TaskRequestV1 = Schema.Struct({ "assigneeId": Schema.optionalKey(Schema.String), "assigneeIds": Schema.optionalKey(Schema.Array(Schema.String.annotate({ "description": "Represents list of assignee ids for the task." })).annotate({ "description": "Represents list of assignee ids for the task." }).check(Schema.isUnique())), "budgetEstimate": Schema.optionalKey(Schema.Number.annotate({ "description": "Represents a task budget estimate as long.", "format": "int64" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0))), "estimate": Schema.optionalKey(Schema.String.annotate({ "description": "Represents a task duration estimate in ISO-8601 format." })), "id": Schema.optionalKey(Schema.String.annotate({ "description": "Represents task identifier across the system." })), "name": Schema.String.annotate({ "description": "Represents task name." }).check(Schema.isMinLength(1)).check(Schema.isMaxLength(1000)), "status": Schema.optionalKey(Schema.Literals(["ACTIVE", "DONE", "ALL"]).annotate({ "description": "Represents task status." })), "userGroupIds": Schema.optionalKey(Schema.Array(Schema.String.annotate({ "description": "Represents list of user group ids for the task." })).annotate({ "description": "Represents list of user group ids for the task." }).check(Schema.isUnique())) })
export type TaskStatus = never
export const TaskStatus = Schema.Never
export type TaxType = never
export const TaxType = Schema.Never
export type TemplateDto = { readonly "id"?: string, readonly "name"?: string, readonly "userId"?: string, readonly "workspaceId"?: string }
export const TemplateDto = Schema.Struct({ "id": Schema.optionalKey(Schema.String.annotate({ "description": "Represents a template identifier across the system." })), "name": Schema.optionalKey(Schema.String.annotate({ "description": "Represents a template name." })), "userId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents a user identifier across the system." })), "workspaceId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents a workspace identifier across the system." })) })
export type TemplatePatchRequest = { readonly "name": string }
export const TemplatePatchRequest = Schema.Struct({ "name": Schema.String.annotate({ "description": "Represents a template name." }).check(Schema.isMinLength(1)) })
export type TimeEntryId = { readonly "dateOfCreationFromObjectId"?: string }
export const TimeEntryId = Schema.Struct({ "dateOfCreationFromObjectId": Schema.optionalKey(Schema.String.annotate({ "format": "date-time" })) }).annotate({ "description": "Represents a list of invoiced time entry ids" })
export type TimeEstimateDto = { readonly "active"?: boolean, readonly "estimate"?: string, readonly "includeNonBillable"?: boolean, readonly "resetOption"?: "WEEKLY" | "MONTHLY" | "YEARLY", readonly "type"?: "AUTO" | "MANUAL" }
export const TimeEstimateDto = Schema.Struct({ "active": Schema.optionalKey(Schema.Boolean), "estimate": Schema.optionalKey(Schema.String.annotate({ "description": "Represents project duration in milliseconds." })), "includeNonBillable": Schema.optionalKey(Schema.Boolean), "resetOption": Schema.optionalKey(Schema.Literals(["WEEKLY", "MONTHLY", "YEARLY"]).annotate({ "description": "Represents a reset option enum." })), "type": Schema.optionalKey(Schema.Literals(["AUTO", "MANUAL"]).annotate({ "description": "Represents an estimate type enum." })) }).annotate({ "description": "Represents a project time estimate object." })
export type TimeEstimateRequest = { readonly "active"?: boolean, readonly "estimate"?: string, readonly "includeNonBillable"?: boolean, readonly "resetOption"?: "WEEKLY" | "MONTHLY" | "YEARLY", readonly "type"?: "AUTO" | "MANUAL" }
export const TimeEstimateRequest = Schema.Struct({ "active": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Flag whether to include only active or inactive estimates." })), "estimate": Schema.optionalKey(Schema.String.annotate({ "description": "Represents a time duration in ISO-8601 format." })), "includeNonBillable": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Flag whether to include non-billable expenses." })), "resetOption": Schema.optionalKey(Schema.Literals(["WEEKLY", "MONTHLY", "YEARLY"]).annotate({ "description": "Represents a reset option enum." })), "type": Schema.optionalKey(Schema.Literals(["AUTO", "MANUAL"]).annotate({ "description": "Represents an estimate type enum." })) }).annotate({ "description": "Represents project time estimate request object." })
export type TimeIntervalDto = { readonly "duration"?: string | null, readonly "end"?: string, readonly "offsetEnd"?: number, readonly "offsetStart"?: number, readonly "start": string, readonly "timeZone"?: string, readonly "zonedEnd"?: string, readonly "zonedStart"?: string }
export const TimeIntervalDto = Schema.Struct({ "duration": Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])), "end": Schema.optionalKey(Schema.Union([Schema.String.annotate({ "format": "date-time" })])), "offsetEnd": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt())), "offsetStart": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt())), "start": Schema.String.annotate({ "format": "date-time" }), "timeZone": Schema.optionalKey(Schema.String), "zonedEnd": Schema.optionalKey(Schema.String.annotate({ "format": "date-time" })), "zonedStart": Schema.optionalKey(Schema.String.annotate({ "format": "date-time" })) }).annotate({ "description": "Represents a time interval object." })
export type TimeIntervalDtoV1 = { readonly "duration"?: string | null, readonly "end"?: string | null, readonly "start"?: string }
export const TimeIntervalDtoV1 = Schema.Struct({ "duration": Schema.optionalKey(Schema.Union([Schema.String, Schema.Null]).annotate({ "description": "Represents a time duration." })), "end": Schema.optionalKey(Schema.Union([Schema.String, Schema.Null]).annotate({ "description": "Represents an end date in yyyy-MM-ddThh:mm:ssZ format." })), "start": Schema.optionalKey(Schema.String.annotate({ "description": "Represents a start date in yyyy-MM-ddThh:mm:ssZ format.", "format": "date-time" })) }).annotate({ "description": "Represents a time interval object." })
export type TimeOffRequestStatus = { readonly "changedAt"?: string, readonly "changedByUserId"?: string, readonly "changedByUserName"?: string, readonly "changedForUserName"?: string, readonly "note"?: string, readonly "statusType"?: "PENDING" | "APPROVED" | "REJECTED" | "ALL" }
export const TimeOffRequestStatus = Schema.Struct({ "changedAt": Schema.optionalKey(Schema.String.annotate({ "format": "date-time" })), "changedByUserId": Schema.optionalKey(Schema.String), "changedByUserName": Schema.optionalKey(Schema.String), "changedForUserName": Schema.optionalKey(Schema.String), "note": Schema.optionalKey(Schema.String), "statusType": Schema.optionalKey(Schema.Literals(["PENDING", "APPROVED", "REJECTED", "ALL"])) }).annotate({ "description": "Represents the status the time off request." })
export type TimeRangeRequestDtoV1 = { readonly "issue-date-end"?: string, readonly "issue-date-start"?: string }
export const TimeRangeRequestDtoV1 = Schema.Struct({ "issue-date-end": Schema.optionalKey(Schema.String.annotate({ "description": "Represents a date in yyyy-MM-dd format. This is the lower bound of the time range." })), "issue-date-start": Schema.optionalKey(Schema.String.annotate({ "description": "Represents a date in yyyy-MM-dd format. This is the lower bound of the time range." })) }).annotate({ "description": "Represents a time range object. If provided, you'll get a filtered list of invoices that has issue date within the time range specified." })
export type TotalsPerDayDto = { readonly "date"?: string, readonly "totalHours"?: number }
export const TotalsPerDayDto = Schema.Struct({ "date": Schema.optionalKey(Schema.String.annotate({ "format": "date-time" })), "totalHours": Schema.optionalKey(Schema.Number.annotate({ "format": "double" }).check(Schema.isFinite())) }).annotate({ "description": "Represents total hours per day object." })
export type UpdateApprovalRequest = { readonly "note"?: string, readonly "state": "PENDING" | "APPROVED" | "WITHDRAWN_SUBMISSION" | "WITHDRAWN_APPROVAL" | "REJECTED" }
export const UpdateApprovalRequest = Schema.Struct({ "note": Schema.optionalKey(Schema.String.annotate({ "description": "Additional notes for the approval request." })), "state": Schema.Literals(["PENDING", "APPROVED", "WITHDRAWN_SUBMISSION", "WITHDRAWN_APPROVAL", "REJECTED"]).annotate({ "description": "Specifies the approval state to set." }) })
export type UpdateBalanceRequestV1 = { readonly "note"?: string, readonly "userIds": ReadonlyArray<string>, readonly "value": number }
export const UpdateBalanceRequestV1 = Schema.Struct({ "note": Schema.optionalKey(Schema.String.annotate({ "description": "Represents a new balance note value." })), "userIds": Schema.Array(Schema.String.annotate({ "description": "Represents the list of users' identifiers whose balance is to be updated." })).annotate({ "description": "Represents the list of users' identifiers whose balance is to be updated." }).check(Schema.isMinLength(1)).check(Schema.isUnique()), "value": Schema.Number.annotate({ "description": "Represents a new balance value.", "format": "double" }).check(Schema.isFinite()).check(Schema.isGreaterThanOrEqualTo(-10000)).check(Schema.isLessThanOrEqualTo(10000)) })
export type UpdateClientRequestV1 = { readonly "address"?: string, readonly "archived"?: boolean, readonly "ccEmails"?: ReadonlyArray<string>, readonly "currencyId"?: string, readonly "email"?: string, readonly "name"?: string, readonly "note"?: string }
export const UpdateClientRequestV1 = Schema.Struct({ "address": Schema.optionalKey(Schema.String.annotate({ "description": "Represents a client's address." }).check(Schema.isMinLength(0)).check(Schema.isMaxLength(3000))), "archived": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates if client will be archived or not." })), "ccEmails": Schema.optionalKey(Schema.Array(Schema.String.annotate({ "format": "email" })).check(Schema.isMinLength(0)).check(Schema.isMaxLength(3))), "currencyId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents a currency identifier across the system." })), "email": Schema.optionalKey(Schema.String.annotate({ "description": "Represents a client email.", "format": "email" })), "name": Schema.optionalKey(Schema.String.annotate({ "description": "Represents a client name." }).check(Schema.isMinLength(0)).check(Schema.isMaxLength(100))), "note": Schema.optionalKey(Schema.String.annotate({ "description": "Represents additional notes for the client." }).check(Schema.isMinLength(0)).check(Schema.isMaxLength(3000))) })
export type UpdateCustomFieldRequest = { readonly "customFieldId": string, readonly "sourceType"?: "WORKSPACE" | "PROJECT" | "TIMEENTRY", readonly "value"?: {  } }
export const UpdateCustomFieldRequest = Schema.Struct({ "customFieldId": Schema.String.annotate({ "description": "Represents custom field identifier across the system." }), "sourceType": Schema.optionalKey(Schema.Literals(["WORKSPACE", "PROJECT", "TIMEENTRY"]).annotate({ "description": "Represents a custom field value source type." })), "value": Schema.optionalKey(Schema.Struct({  }).annotate({ "description": "Represents a custom field's value." })) }).annotate({ "description": "Represents a list of value objects for user’s custom fields." })
export type UpdateCustomFieldRequestV1 = { readonly "allowedValues"?: ReadonlyArray<string>, readonly "description"?: string, readonly "name": string, readonly "onlyAdminCanEdit"?: boolean, readonly "placeholder"?: string, readonly "required"?: boolean, readonly "status"?: "INACTIVE" | "VISIBLE" | "INVISIBLE", readonly "type": "TXT" | "NUMBER" | "DROPDOWN_SINGLE" | "DROPDOWN_MULTIPLE" | "CHECKBOX" | "LINK", readonly "workspaceDefaultValue"?: {  } }
export const UpdateCustomFieldRequestV1 = Schema.Struct({ "allowedValues": Schema.optionalKey(Schema.Array(Schema.String.annotate({ "description": "Represents a list of custom field's allowed values." })).annotate({ "description": "Represents a list of custom field's allowed values." })), "description": Schema.optionalKey(Schema.String.annotate({ "description": "Represents a custom field description." })), "name": Schema.String.annotate({ "description": "Represents a custom field name." }).check(Schema.isMinLength(2)).check(Schema.isMaxLength(250)), "onlyAdminCanEdit": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Flag to set whether custom field is modifiable only by admin users." })), "placeholder": Schema.optionalKey(Schema.String.annotate({ "description": "Represents a custom field placeholder value." })), "required": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Flag to set whether custom field is mandatory or not." })), "status": Schema.optionalKey(Schema.Literals(["INACTIVE", "VISIBLE", "INVISIBLE"]).annotate({ "description": "Represents a custom field status" })), "type": Schema.Literals(["TXT", "NUMBER", "DROPDOWN_SINGLE", "DROPDOWN_MULTIPLE", "CHECKBOX", "LINK"]).annotate({ "description": "Represents a custom field type." }), "workspaceDefaultValue": Schema.optionalKey(Schema.Struct({  }).annotate({ "description": "Represents a custom field's default value in the workspace." })) })
export type UpdateExpenseV1Request = { readonly "amount": number, readonly "billable"?: boolean, readonly "categoryId": string, readonly "changeFields": ReadonlyArray<"USER" | "DATE" | "PROJECT" | "TASK" | "CATEGORY" | "NOTES" | "AMOUNT" | "BILLABLE" | "FILE">, readonly "date": string, readonly "file": string, readonly "notes"?: string, readonly "projectId"?: string, readonly "taskId"?: string, readonly "userId": string }
export const UpdateExpenseV1Request = Schema.Struct({ "amount": Schema.Number.annotate({ "description": "Represents an expense amount as the double data type.", "format": "double" }).check(Schema.isFinite()).check(Schema.isGreaterThanOrEqualTo(0)).check(Schema.isLessThanOrEqualTo(92233720368547760)), "billable": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether expense is billable or not." })), "categoryId": Schema.String.annotate({ "description": "Represents a category identifier across the system." }), "changeFields": Schema.Array(Schema.Literals(["USER", "DATE", "PROJECT", "TASK", "CATEGORY", "NOTES", "AMOUNT", "BILLABLE", "FILE"]).annotate({ "description": "Represents a list of expense change fields." })).annotate({ "description": "Represents a list of expense change fields." }), "date": Schema.String.annotate({ "description": "Provides a valid yyyy-MM-ddThh:mm:ssZ format date.", "format": "date-time" }), "file": Schema.String.annotate({ "format": "binary" }), "notes": Schema.optionalKey(Schema.String.annotate({ "description": "Represents notes for an expense." }).check(Schema.isMinLength(0)).check(Schema.isMaxLength(3000))), "projectId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents a project identifier across the system." })), "taskId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents a task identifier across the system." })), "userId": Schema.String.annotate({ "description": "Represents a user identifier across the system." }).check(Schema.isMinLength(1)) })
export type UpdateTagRequest = { readonly "archived"?: boolean, readonly "name"?: string }
export const UpdateTagRequest = Schema.Struct({ "archived": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether a tag will be archived or not." })), "name": Schema.optionalKey(Schema.String.annotate({ "description": "Represents a tag name." }).check(Schema.isMinLength(0)).check(Schema.isMaxLength(100))) })
export type UpdateTaskRequest = { readonly "assigneeId"?: string, readonly "assigneeIds"?: ReadonlyArray<string>, readonly "billable"?: boolean, readonly "budgetEstimate"?: number, readonly "estimate"?: string, readonly "name": string, readonly "status"?: "ACTIVE" | "DONE" | "ALL", readonly "userGroupIds"?: ReadonlyArray<string> }
export const UpdateTaskRequest = Schema.Struct({ "assigneeId": Schema.optionalKey(Schema.String), "assigneeIds": Schema.optionalKey(Schema.Array(Schema.String.annotate({ "description": "Represents list of assignee ids for the task." })).annotate({ "description": "Represents list of assignee ids for the task." }).check(Schema.isUnique())), "billable": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether a task is billable or not." })), "budgetEstimate": Schema.optionalKey(Schema.Number.annotate({ "description": "Represents a task budget estimate as integer.", "format": "int64" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0))), "estimate": Schema.optionalKey(Schema.String.annotate({ "description": "Represents a task duration estimate." })), "name": Schema.String.annotate({ "description": "Represents task name." }).check(Schema.isMinLength(1)).check(Schema.isMaxLength(1000)), "status": Schema.optionalKey(Schema.Literals(["ACTIVE", "DONE", "ALL"]).annotate({ "description": "Represents task status." })), "userGroupIds": Schema.optionalKey(Schema.Array(Schema.String.annotate({ "description": "Represents list of user group ids for the task." })).annotate({ "description": "Represents list of user group ids for the task." }).check(Schema.isUnique())) })
export type UpdateUserGroupRequest = { readonly "name"?: string }
export const UpdateUserGroupRequest = Schema.Struct({ "name": Schema.optionalKey(Schema.String.annotate({ "description": "Represents a user group name." }).check(Schema.isMinLength(0)).check(Schema.isMaxLength(100))) })
export type UpdateUserStatusRequest = { readonly "status": "ACTIVE" | "INACTIVE" }
export const UpdateUserStatusRequest = Schema.Struct({ "status": Schema.Literals(["ACTIVE", "INACTIVE"]).annotate({ "description": "Represents membership status." }) })
export type UpdateWebhookRequestV1 = { readonly "name"?: string, readonly "triggerSource": ReadonlyArray<string>, readonly "triggerSourceType": "PROJECT_ID" | "USER_ID" | "TAG_ID" | "TASK_ID" | "WORKSPACE_ID" | "ASSIGNMENT_ID" | "EXPENSE_ID", readonly "url": string, readonly "webhookEvent": "NEW_PROJECT" | "NEW_TASK" | "NEW_CLIENT" | "NEW_TIMER_STARTED" | "TIMER_STOPPED" | "TIME_ENTRY_UPDATED" | "TIME_ENTRY_DELETED" | "TIME_ENTRY_SPLIT" | "NEW_TIME_ENTRY" | "TIME_ENTRY_RESTORED" | "NEW_TAG" | "USER_DELETED_FROM_WORKSPACE" | "USER_JOINED_WORKSPACE" | "USER_DEACTIVATED_ON_WORKSPACE" | "USER_ACTIVATED_ON_WORKSPACE" | "USER_EMAIL_CHANGED" | "USER_UPDATED" | "NEW_INVOICE" | "INVOICE_UPDATED" | "NEW_APPROVAL_REQUEST" | "APPROVAL_REQUEST_STATUS_UPDATED" | "TIME_OFF_REQUESTED" | "TIME_OFF_REQUEST_UPDATED" | "TIME_OFF_REQUEST_APPROVED" | "TIME_OFF_REQUEST_REJECTED" | "TIME_OFF_REQUEST_STARTED" | "TIME_OFF_REQUEST_WITHDRAWN" | "BALANCE_UPDATED" | "TAG_UPDATED" | "TAG_DELETED" | "TASK_UPDATED" | "CLIENT_UPDATED" | "TASK_DELETED" | "CLIENT_DELETED" | "EXPENSE_RESTORED" | "ASSIGNMENT_CREATED" | "ASSIGNMENT_DELETED" | "ASSIGNMENT_PUBLISHED" | "ASSIGNMENT_UPDATED" | "EXPENSE_CREATED" | "EXPENSE_DELETED" | "EXPENSE_UPDATED" | "PROJECT_UPDATED" | "PROJECT_DELETED" | "USER_GROUP_CREATED" | "USER_GROUP_UPDATED" | "USER_GROUP_DELETED" | "USERS_INVITED_TO_WORKSPACE" | "LIMITED_USERS_ADDED_TO_WORKSPACE" | "COST_RATE_UPDATED" | "BILLABLE_RATE_UPDATED" }
export const UpdateWebhookRequestV1 = Schema.Struct({ "name": Schema.optionalKey(Schema.String.annotate({ "description": "Represents a webhook name." }).check(Schema.isMinLength(2)).check(Schema.isMaxLength(30))), "triggerSource": Schema.Array(Schema.String.annotate({ "description": "Represents a list of trigger sources." })).annotate({ "description": "Represents a list of trigger sources." }), "triggerSourceType": Schema.Literals(["PROJECT_ID", "USER_ID", "TAG_ID", "TASK_ID", "WORKSPACE_ID", "ASSIGNMENT_ID", "EXPENSE_ID"]).annotate({ "description": "Represents a webhook event trigger source type." }), "url": Schema.String.annotate({ "description": "Represents a workspace identifier across the system." }).check(Schema.isMinLength(1)), "webhookEvent": Schema.Literals(["NEW_PROJECT", "NEW_TASK", "NEW_CLIENT", "NEW_TIMER_STARTED", "TIMER_STOPPED", "TIME_ENTRY_UPDATED", "TIME_ENTRY_DELETED", "TIME_ENTRY_SPLIT", "NEW_TIME_ENTRY", "TIME_ENTRY_RESTORED", "NEW_TAG", "USER_DELETED_FROM_WORKSPACE", "USER_JOINED_WORKSPACE", "USER_DEACTIVATED_ON_WORKSPACE", "USER_ACTIVATED_ON_WORKSPACE", "USER_EMAIL_CHANGED", "USER_UPDATED", "NEW_INVOICE", "INVOICE_UPDATED", "NEW_APPROVAL_REQUEST", "APPROVAL_REQUEST_STATUS_UPDATED", "TIME_OFF_REQUESTED", "TIME_OFF_REQUEST_UPDATED", "TIME_OFF_REQUEST_APPROVED", "TIME_OFF_REQUEST_REJECTED", "TIME_OFF_REQUEST_STARTED", "TIME_OFF_REQUEST_WITHDRAWN", "BALANCE_UPDATED", "TAG_UPDATED", "TAG_DELETED", "TASK_UPDATED", "CLIENT_UPDATED", "TASK_DELETED", "CLIENT_DELETED", "EXPENSE_RESTORED", "ASSIGNMENT_CREATED", "ASSIGNMENT_DELETED", "ASSIGNMENT_PUBLISHED", "ASSIGNMENT_UPDATED", "EXPENSE_CREATED", "EXPENSE_DELETED", "EXPENSE_UPDATED", "PROJECT_UPDATED", "PROJECT_DELETED", "USER_GROUP_CREATED", "USER_GROUP_UPDATED", "USER_GROUP_DELETED", "USERS_INVITED_TO_WORKSPACE", "LIMITED_USERS_ADDED_TO_WORKSPACE", "COST_RATE_UPDATED", "BILLABLE_RATE_UPDATED"]).annotate({ "description": "Represents a webhook event type." }) })
export type UploadFileResponseV1 = { readonly "name"?: string, readonly "url"?: string }
export const UploadFileResponseV1 = Schema.Struct({ "name": Schema.optionalKey(Schema.String.annotate({ "description": "File name of the uploaded image" })), "url": Schema.optionalKey(Schema.String.annotate({ "description": "The URL of the uploaded image in the server" })) })
export type UpsertUserCustomFieldRequest = { readonly "customFieldId": string, readonly "value"?: {  } }
export const UpsertUserCustomFieldRequest = Schema.Struct({ "customFieldId": Schema.String.annotate({ "description": "Represents custom field identifier across the system." }), "value": Schema.optionalKey(Schema.Struct({  }).annotate({ "description": "Represents custom field value." })) }).annotate({ "description": "Represents a list of upsert user custom field request." })
export type UpsertUserCustomFieldRequestV1 = { readonly "value"?: {  } }
export const UpsertUserCustomFieldRequestV1 = Schema.Struct({ "value": Schema.optionalKey(Schema.Struct({  }).annotate({ "description": "Represents custom field value." })) })
export type UserGroupIdsSchema = { readonly "contains"?: "CONTAINS" | "DOES_NOT_CONTAIN", readonly "ids"?: ReadonlyArray<string>, readonly "status"?: "ALL" | "ACTIVE" | "INACTIVE" }
export const UserGroupIdsSchema = Schema.Struct({ "contains": Schema.optionalKey(Schema.Literals(["CONTAINS", "DOES_NOT_CONTAIN"])), "ids": Schema.optionalKey(Schema.Array(Schema.String.annotate({ "description": "Represents ids upon which filtering is performed." })).annotate({ "description": "Represents ids upon which filtering is performed." }).check(Schema.isUnique())), "status": Schema.optionalKey(Schema.Literals(["ALL", "ACTIVE", "INACTIVE"]).annotate({ "description": "Represents user status." })) }).annotate({ "description": "Provide list with user group ids and corresponding status." })
export type UserGroupRequest = { readonly "name"?: string }
export const UserGroupRequest = Schema.Struct({ "name": Schema.optionalKey(Schema.String.annotate({ "description": "Represents a user group name." }).check(Schema.isMinLength(0)).check(Schema.isMaxLength(100))) })
export type UserGroupUserRequest = { readonly "userId": string }
export const UserGroupUserRequest = Schema.Struct({ "userId": Schema.String.annotate({ "description": "Represents a user identifier across the system." }) })
export type UserIdsSchema = { readonly "contains"?: "CONTAINS" | "DOES_NOT_CONTAIN", readonly "ids"?: ReadonlyArray<string>, readonly "status"?: "ALL" | "ACTIVE" | "INACTIVE" }
export const UserIdsSchema = Schema.Struct({ "contains": Schema.optionalKey(Schema.Literals(["CONTAINS", "DOES_NOT_CONTAIN"])), "ids": Schema.optionalKey(Schema.Array(Schema.String.annotate({ "description": "Represents ids upon which filtering is performed." })).annotate({ "description": "Represents ids upon which filtering is performed." }).check(Schema.isUnique())), "status": Schema.optionalKey(Schema.Literals(["ALL", "ACTIVE", "INACTIVE"]).annotate({ "description": "Represents user status." })) }).annotate({ "description": "Provide list with user ids and corresponding status." })
export type UserRedactedDtoV1 = { readonly "id"?: string, readonly "name"?: string }
export const UserRedactedDtoV1 = Schema.Struct({ "id": Schema.optionalKey(Schema.String), "name": Schema.optionalKey(Schema.String) }).annotate({ "description": "Represents a list of assigned team managers for this user group." })
export type VisibleZeroFieldsInvoice = never
export const VisibleZeroFieldsInvoice = Schema.Never
export type WebhookEventStatusWithLatestLogDtoV1 = { readonly "id"?: string, readonly "requestBody"?: string, readonly "respondedAt"?: string, readonly "responseBody"?: string, readonly "retryCount"?: number, readonly "status"?: string, readonly "statusCode"?: number, readonly "webhookId"?: string, readonly "webhookLogId"?: string }
export const WebhookEventStatusWithLatestLogDtoV1 = Schema.Struct({ "id": Schema.optionalKey(Schema.String.annotate({ "description": "Represents log identifier across the system." })), "requestBody": Schema.optionalKey(Schema.String.annotate({ "description": "Represents request body." })), "respondedAt": Schema.optionalKey(Schema.String.annotate({ "description": "Represents date and time of response." })), "responseBody": Schema.optionalKey(Schema.String.annotate({ "description": "Represents response body." })), "retryCount": Schema.optionalKey(Schema.Number.annotate({ "description": "Represents how many times we tried to deliver the webhook event.", "format": "int32" }).check(Schema.isInt())), "status": Schema.optionalKey(Schema.String.annotate({ "description": "Represents delivery status of the webhook event." })), "statusCode": Schema.optionalKey(Schema.Number.annotate({ "description": "Represents response status code.", "format": "int32" }).check(Schema.isInt())), "webhookId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents log identifier across the system." })), "webhookLogId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents log identifier across the system." })) })
export type WebhookEventTriggerSourceType = never
export const WebhookEventTriggerSourceType = Schema.Never
export type WebhookEventType = never
export const WebhookEventType = Schema.Never
export type WebhookLogDtoV1 = { readonly "id"?: string, readonly "requestBody"?: string, readonly "respondedAt"?: string, readonly "responseBody"?: string, readonly "statusCode"?: number, readonly "webhookEventStatusId"?: string, readonly "webhookId"?: string }
export const WebhookLogDtoV1 = Schema.Struct({ "id": Schema.optionalKey(Schema.String.annotate({ "description": "Represents log identifier across the system." })), "requestBody": Schema.optionalKey(Schema.String.annotate({ "description": "Represents request body." })), "respondedAt": Schema.optionalKey(Schema.String.annotate({ "description": "Represents date and time of response." })), "responseBody": Schema.optionalKey(Schema.String.annotate({ "description": "Represents response body." })), "statusCode": Schema.optionalKey(Schema.Number.annotate({ "description": "Represents response status code.", "format": "int32" }).check(Schema.isInt())), "webhookEventStatusId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents webhook event status identifier across the system." })), "webhookId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents webhook identifier across the system." })) })
export type WebhookLogSearchRequestV1 = { readonly "from"?: string, readonly "sortByNewest"?: boolean, readonly "status"?: "ALL" | "SUCCEEDED" | "FAILED", readonly "to"?: string }
export const WebhookLogSearchRequestV1 = Schema.Struct({ "from": Schema.optionalKey(Schema.String.annotate({ "description": "Represents date and time in yyyy-MM-ddThh:mm:ssZ format. If provided, results will include logs which occurred after this value.", "format": "date-time" })), "sortByNewest": Schema.optionalKey(Schema.Boolean.annotate({ "description": "If set to true, logs will be sorted with most recent first." })), "status": Schema.optionalKey(Schema.Literals(["ALL", "SUCCEEDED", "FAILED"]).annotate({ "description": "Filters logs by status." })), "to": Schema.optionalKey(Schema.String.annotate({ "description": "Represents date and time in yyyy-MM-ddThh:mm:ssZ format. If provided, results will include logs which occurred before this value.", "format": "date-time" })) })
export type WorkspaceSubdomainDtoV1 = { readonly "enabled"?: boolean, readonly "name"?: string }
export const WorkspaceSubdomainDtoV1 = Schema.Struct({ "enabled": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether subdomain is enabled on workspace" })), "name": Schema.optionalKey(Schema.String.annotate({ "description": "Represents subdomain name" })) }).annotate({ "description": "Represents the workspace subdomain" })
export type AmountDto = { readonly "type"?: "EARNED" | "COST" | "PROFIT" | "HIDE_AMOUNT" | "EXPORT", readonly "value"?: number }
export const AmountDto = Schema.Struct({ "type": Schema.optionalKey(Schema.Literals(["EARNED", "COST", "PROFIT", "HIDE_AMOUNT", "EXPORT"]).annotate({ "description": "Represents amount type" })), "value": Schema.optionalKey(Schema.Number.annotate({ "description": "Represents amount value" }).check(Schema.isFinite())) }).annotate({ "description": "List of amounts" })
export type AttendanceDto = { readonly "break"?: number, readonly "capacity"?: number, readonly "date"?: string, readonly "endTime"?: string, readonly "hasRunningEntry"?: boolean, readonly "imageUrl"?: string, readonly "overtime"?: number, readonly "remainingCapacity"?: number, readonly "startTime"?: string, readonly "timeOff"?: number, readonly "totalDuration"?: number, readonly "userId"?: string, readonly "userName"?: string }
export const AttendanceDto = Schema.Struct({ "break": Schema.optionalKey(Schema.Number.annotate({ "format": "int64" }).check(Schema.isInt())), "capacity": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt())), "date": Schema.optionalKey(Schema.String), "endTime": Schema.optionalKey(Schema.String), "hasRunningEntry": Schema.optionalKey(Schema.Boolean), "imageUrl": Schema.optionalKey(Schema.String), "overtime": Schema.optionalKey(Schema.Number.annotate({ "format": "int64" }).check(Schema.isInt())), "remainingCapacity": Schema.optionalKey(Schema.Number.annotate({ "format": "int64" }).check(Schema.isInt())), "startTime": Schema.optionalKey(Schema.String), "timeOff": Schema.optionalKey(Schema.Number.annotate({ "format": "int64" }).check(Schema.isInt())), "totalDuration": Schema.optionalKey(Schema.Number.annotate({ "format": "int64" }).check(Schema.isInt())), "userId": Schema.optionalKey(Schema.String), "userName": Schema.optionalKey(Schema.String) }).annotate({ "description": "List of entities" })
export type AuditFilterV1 = { readonly "duration"?: number, readonly "durationShorter"?: boolean, readonly "withoutProject"?: boolean, readonly "withoutTask"?: boolean }
export const AuditFilterV1 = Schema.Struct({ "duration": Schema.optionalKey(Schema.Number.annotate({ "description": "Represent audit duration.", "format": "int32" }).check(Schema.isInt())), "durationShorter": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Represent audit duration shorter." })), "withoutProject": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether to filter without a project." })), "withoutTask": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether to filter without a task." })) })
export type CompareBalanceFilter = { readonly "filtrationType"?: "EXACTLY" | "LARGER_THAN" | "SMALLER_THAN", readonly "value"?: string }
export const CompareBalanceFilter = Schema.Struct({ "filtrationType": Schema.optionalKey(Schema.Literals(["EXACTLY", "LARGER_THAN", "SMALLER_THAN"])), "value": Schema.optionalKey(Schema.String.annotate({ "description": "Represents balance of work (difference between overtime and undertime) in hours, multiplied by 100. For example, if desired value is 1.5h, input should be 150." })) })
export type CompareBreakFilter = { readonly "filtrationType"?: "EXACTLY" | "LARGER_THAN" | "SMALLER_THAN", readonly "value"?: string }
export const CompareBreakFilter = Schema.Struct({ "filtrationType": Schema.optionalKey(Schema.Literals(["EXACTLY", "LARGER_THAN", "SMALLER_THAN"])), "value": Schema.optionalKey(Schema.String.annotate({ "description": "Represents duration of breaks in the day in hours, multiplied by 100. For example, if desired value is 0.5h, input should be 50" })) })
export type CompareCapacityFilter = { readonly "filtrationType"?: "EXACTLY" | "LARGER_THAN" | "SMALLER_THAN", readonly "value"?: string }
export const CompareCapacityFilter = Schema.Struct({ "filtrationType": Schema.optionalKey(Schema.Literals(["EXACTLY", "LARGER_THAN", "SMALLER_THAN"])), "value": Schema.optionalKey(Schema.String.annotate({ "description": "Represents daily work capacity of user in hours, multiplied by 100. For example, if desired value is 7.5h, input should be 750." })) })
export type CompareEndFilter = { readonly "filtrationType"?: "EXACTLY" | "LARGER_THAN" | "SMALLER_THAN", readonly "value"?: string }
export const CompareEndFilter = Schema.Struct({ "filtrationType": Schema.optionalKey(Schema.Literals(["EXACTLY", "LARGER_THAN", "SMALLER_THAN"])), "value": Schema.optionalKey(Schema.String.annotate({ "description": "Represents end time in 24-hour notation." })) })
export type CompareOvertimeFilter = { readonly "filtrationType"?: "EXACTLY" | "LARGER_THAN" | "SMALLER_THAN", readonly "value"?: string }
export const CompareOvertimeFilter = Schema.Struct({ "filtrationType": Schema.optionalKey(Schema.Literals(["EXACTLY", "LARGER_THAN", "SMALLER_THAN"])), "value": Schema.optionalKey(Schema.String.annotate({ "description": "Represents duration of overtime work (difference between work and capacity - if positive) in hours, multiplied by 100. For example, if desired value is 1.5h, input should be 150." })) })
export type CompareStartFilter = { readonly "filtrationType"?: "EXACTLY" | "LARGER_THAN" | "SMALLER_THAN", readonly "value"?: string }
export const CompareStartFilter = Schema.Struct({ "filtrationType": Schema.optionalKey(Schema.Literals(["EXACTLY", "LARGER_THAN", "SMALLER_THAN"])), "value": Schema.optionalKey(Schema.String.annotate({ "description": "Represents start time in 24-hour notation." })) })
export type CompareUndertimeFilter = { readonly "filtrationType"?: "EXACTLY" | "LARGER_THAN" | "SMALLER_THAN", readonly "value"?: string }
export const CompareUndertimeFilter = Schema.Struct({ "filtrationType": Schema.optionalKey(Schema.Literals(["EXACTLY", "LARGER_THAN", "SMALLER_THAN"])), "value": Schema.optionalKey(Schema.String.annotate({ "description": "Represents duration of undertime work (difference between work and capacity - if negative) in hours, multiplied by 100. For example, if desired value is 1.5h, input should be 150." })) })
export type CompareWorkFilter = { readonly "filtrationType"?: "EXACTLY" | "LARGER_THAN" | "SMALLER_THAN", readonly "value"?: string }
export const CompareWorkFilter = Schema.Struct({ "filtrationType": Schema.optionalKey(Schema.Literals(["EXACTLY", "LARGER_THAN", "SMALLER_THAN"])), "value": Schema.optionalKey(Schema.String.annotate({ "description": "Represents duration of completed work for day in hours, multiplied by 100. For example, if desired value is 7.5h, input should be 750." })) })
export type ContainsArchivedFilterV1 = { readonly "contains"?: "CONTAINS" | "DOES_NOT_CONTAIN" | "CONTAINS_ONLY", readonly "ids"?: ReadonlyArray<string>, readonly "status"?: "ACTIVE" | "ARCHIVED" | "ALL" }
export const ContainsArchivedFilterV1 = Schema.Struct({ "contains": Schema.optionalKey(Schema.Literals(["CONTAINS", "DOES_NOT_CONTAIN", "CONTAINS_ONLY"]).annotate({ "description": "Represents a contains type." })), "ids": Schema.optionalKey(Schema.Array(Schema.String.annotate({ "description": "Filter includes provided list of ids." })).annotate({ "description": "Filter includes provided list of ids." }).check(Schema.isUnique())), "status": Schema.optionalKey(Schema.Literals(["ACTIVE", "ARCHIVED", "ALL"]).annotate({ "description": "Filter entities in 'contains' by their status." })) })
export type ContainsTagFilterV1 = { readonly "containedInTimeentry"?: "CONTAINS" | "DOES_NOT_CONTAIN" | "CONTAINS_ONLY", readonly "contains"?: "CONTAINS" | "DOES_NOT_CONTAIN" | "CONTAINS_ONLY", readonly "ids"?: ReadonlyArray<string>, readonly "status"?: "ACTIVE" | "ARCHIVED" | "ALL" }
export const ContainsTagFilterV1 = Schema.Struct({ "containedInTimeentry": Schema.optionalKey(Schema.Literals(["CONTAINS", "DOES_NOT_CONTAIN", "CONTAINS_ONLY"]).annotate({ "description": "If provided, you'll get result filtered by value of contained in time entry." })), "contains": Schema.optionalKey(Schema.Literals(["CONTAINS", "DOES_NOT_CONTAIN", "CONTAINS_ONLY"]).annotate({ "description": "Represents a contains type." })), "ids": Schema.optionalKey(Schema.Array(Schema.String.annotate({ "description": "Filter includes provided list of ids." })).annotate({ "description": "Filter includes provided list of ids." }).check(Schema.isUnique())), "status": Schema.optionalKey(Schema.Literals(["ACTIVE", "ARCHIVED", "ALL"]).annotate({ "description": "Filter entities in 'contains' by their status." })) }).annotate({ "description": "Represents an object for filtering entries by tags." })
export type ContainsTaskFilterV1 = { readonly "contains"?: "CONTAINS" | "DOES_NOT_CONTAIN" | "CONTAINS_ONLY", readonly "ids"?: ReadonlyArray<string>, readonly "status"?: "ACTIVE" | "ARCHIVED" | "ALL" }
export const ContainsTaskFilterV1 = Schema.Struct({ "contains": Schema.optionalKey(Schema.Literals(["CONTAINS", "DOES_NOT_CONTAIN", "CONTAINS_ONLY"]).annotate({ "description": "Represents a contains type." })), "ids": Schema.optionalKey(Schema.Array(Schema.String.annotate({ "description": "Filter includes provided list of ids." })).annotate({ "description": "Filter includes provided list of ids." }).check(Schema.isUnique())), "status": Schema.optionalKey(Schema.Literals(["ACTIVE", "ARCHIVED", "ALL"]).annotate({ "description": "Filter entities in 'contains' by their status." })) }).annotate({ "description": "Represents filter criteria for expenses associated with tasks." })
export type ContainsUsersFilterV1 = { readonly "contains"?: "CONTAINS" | "DOES_NOT_CONTAIN" | "CONTAINS_ONLY", readonly "ids"?: ReadonlyArray<string>, readonly "status"?: "ALL" | "ACTIVE_WITH_PENDING" | "ACTIVE" | "PENDING" | "INACTIVE" }
export const ContainsUsersFilterV1 = Schema.Struct({ "contains": Schema.optionalKey(Schema.Literals(["CONTAINS", "DOES_NOT_CONTAIN", "CONTAINS_ONLY"]).annotate({ "description": "Represents a contains type." })), "ids": Schema.optionalKey(Schema.Array(Schema.String.annotate({ "description": "Filter includes provided list of ids." })).annotate({ "description": "Filter includes provided list of ids." }).check(Schema.isUnique())), "status": Schema.optionalKey(Schema.Literals(["ALL", "ACTIVE_WITH_PENDING", "ACTIVE", "PENDING", "INACTIVE"]).annotate({ "description": "Filter entities in 'contains' by their status." })) })
export type CustomFieldFilterV1 = { readonly "id"?: string, readonly "isEmpty"?: boolean, readonly "numberCondition"?: "EQUAL" | "GREATER_THAN" | "LESS_THAN", readonly "type"?: "TXT" | "NUMBER" | "DROPDOWN_SINGLE" | "DROPDOWN_MULTIPLE" | "CHECKBOX" | "LINK", readonly "value"?: {  } }
export const CustomFieldFilterV1 = Schema.Struct({ "id": Schema.optionalKey(Schema.String.annotate({ "description": "Represents a custom field identifier across the system." })), "isEmpty": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether the custom field is empty." })), "numberCondition": Schema.optionalKey(Schema.Literals(["EQUAL", "GREATER_THAN", "LESS_THAN"]).annotate({ "description": "Represents a custom field number condition." })), "type": Schema.optionalKey(Schema.Literals(["TXT", "NUMBER", "DROPDOWN_SINGLE", "DROPDOWN_MULTIPLE", "CHECKBOX", "LINK"]).annotate({ "description": "Represents a type of custom field." })), "value": Schema.optionalKey(Schema.Struct({  }).annotate({ "description": "Represents a custom field value." })) }).annotate({ "description": "Represents list of time entry custom field filter objects." })
export type DailyTotalDto = { readonly "amount"?: number, readonly "date"?: string, readonly "duration"?: number }
export const DailyTotalDto = Schema.Struct({ "amount": Schema.optionalKey(Schema.Number.check(Schema.isFinite())), "date": Schema.optionalKey(Schema.String), "duration": Schema.optionalKey(Schema.Number.check(Schema.isFinite())) }).annotate({ "description": "Represents list of days" })
export type DetailedOptionsV1 = { readonly "totals"?: "CALCULATE" | "EXCLUDE" }
export const DetailedOptionsV1 = Schema.Struct({ "totals": Schema.optionalKey(Schema.Literals(["CALCULATE", "EXCLUDE"])) })
export type EntityName = { readonly "id"?: string, readonly "name"?: string }
export const EntityName = Schema.Struct({ "id": Schema.optionalKey(Schema.String), "name": Schema.optionalKey(Schema.String) })
export type ExpenseTotalsDtoV1 = { readonly "expensesCount"?: number, readonly "totalAmount"?: number, readonly "totalAmountBillable"?: number }
export const ExpenseTotalsDtoV1 = Schema.Struct({ "expensesCount": Schema.optionalKey(Schema.Number.annotate({ "description": "Represents expenses count", "format": "int32" }).check(Schema.isInt())), "totalAmount": Schema.optionalKey(Schema.Number.annotate({ "description": "Represents total amount of expenses", "format": "double" }).check(Schema.isFinite())), "totalAmountBillable": Schema.optionalKey(Schema.Number.annotate({ "description": "Represents total billable amount of expenses", "format": "double" }).check(Schema.isFinite())) }).annotate({ "description": "Represents expense totals" })
export type ReportTagDto = { readonly "id"?: string, readonly "name"?: string }
export const ReportTagDto = Schema.Struct({ "id": Schema.optionalKey(Schema.String.annotate({ "description": "Represents tag identifier across the system." })), "name": Schema.optionalKey(Schema.String.annotate({ "description": "Represents tag name." })) }).annotate({ "description": "List of tags" })
export type ReportTimeIntervalDto = { readonly "duration"?: number, readonly "end"?: string, readonly "start"?: string }
export const ReportTimeIntervalDto = Schema.Struct({ "duration": Schema.optionalKey(Schema.Number.annotate({ "description": "Represents the duration of interval.", "format": "int32" }).check(Schema.isInt())), "end": Schema.optionalKey(Schema.String.annotate({ "description": "Represents the end datetime. Date is in format YYYY-MM-DDTHH:MM:SS.ssssssZ" })), "start": Schema.optionalKey(Schema.String.annotate({ "description": "Represents the start datetime. Date is in format YYYY-MM-DDTHH:MM:SS.ssssssZ" })) }).annotate({ "description": "Represents time interval" })
export type SummaryFilterV1 = { readonly "groups"?: ReadonlyArray<string>, readonly "sortColumn"?: "GROUP" | "DURATION" | "AMOUNT" | "EARNED" | "COST" | "PROFIT", readonly "summaryChartType"?: "BILLABILITY" | "PROJECT" }
export const SummaryFilterV1 = Schema.Struct({ "groups": Schema.optionalKey(Schema.Array(Schema.String.annotate({ "description": "Represents group ids" })).annotate({ "description": "Represents group ids" })), "sortColumn": Schema.optionalKey(Schema.Literals(["GROUP", "DURATION", "AMOUNT", "EARNED", "COST", "PROFIT"]).annotate({ "description": "If provided, you'll get sorted result by provided sort column." })), "summaryChartType": Schema.optionalKey(Schema.Literals(["BILLABILITY", "PROJECT"]).annotate({ "description": "If provided, you'll get sorted result by provided summary chart type." })) }).annotate({ "description": "Represents a summary report filter." })
export type SummaryReportChartDto = { readonly "earned"?: number, readonly "id"?: string, readonly "totalAmount"?: number, readonly "totalBillableTime"?: number, readonly "totalTime"?: number }
export const SummaryReportChartDto = Schema.Struct({ "earned": Schema.optionalKey(Schema.Number.annotate({ "description": "Represents how much is earned" }).check(Schema.isFinite())), "id": Schema.optionalKey(Schema.String.annotate({ "description": "Represents summary report identifier across the system." })), "totalAmount": Schema.optionalKey(Schema.Number.annotate({ "description": "Represents total amount" }).check(Schema.isFinite())), "totalBillableTime": Schema.optionalKey(Schema.Number.annotate({ "description": "Represents total billable time" }).check(Schema.isFinite())), "totalTime": Schema.optionalKey(Schema.Number.annotate({ "description": "Represents total time" }).check(Schema.isFinite())) }).annotate({ "description": "List of summary report charts" })
export type UpdateSharedReportRequestV1 = { readonly "fixedDate"?: boolean, readonly "isPublic"?: boolean, readonly "name": string, readonly "visibleToUserGroups"?: ReadonlyArray<string>, readonly "visibleToUsers"?: ReadonlyArray<string> }
export const UpdateSharedReportRequestV1 = Schema.Struct({ "fixedDate": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether the shared report has a fixed date range." })), "isPublic": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether the shared report is public." })), "name": Schema.String.annotate({ "description": "Represents a shared reports name." }), "visibleToUserGroups": Schema.optionalKey(Schema.Array(Schema.String.annotate({ "description": "Provide user groups ids to which the shared report is visible." })).annotate({ "description": "Provide user groups ids to which the shared report is visible." }).check(Schema.isUnique())), "visibleToUsers": Schema.optionalKey(Schema.Array(Schema.String.annotate({ "description": "Provide user ids to which the shared report is visible." })).annotate({ "description": "Provide user ids to which the shared report is visible." }).check(Schema.isUnique())) })
export type UserDto = { readonly "dateFormat"?: string, readonly "email": string, readonly "id": string, readonly "name": string, readonly "timeFormat"?: string, readonly "timeZone"?: string, readonly "weekStart"?: string, readonly "activeWorkspace": string, readonly "defaultWorkspace": string, readonly "profilePicture"?: string, readonly "status": string }
export const UserDto = Schema.Struct({ "dateFormat": Schema.optionalKey(Schema.String), "email": Schema.String, "id": Schema.String, "name": Schema.String, "timeFormat": Schema.optionalKey(Schema.String), "timeZone": Schema.optionalKey(Schema.String), "weekStart": Schema.optionalKey(Schema.String), "activeWorkspace": Schema.String, "defaultWorkspace": Schema.String, "profilePicture": Schema.optionalKey(Schema.String), "status": Schema.String })
export type WeeklyFilterV1 = { readonly "group"?: string, readonly "subgroup"?: string }
export const WeeklyFilterV1 = Schema.Struct({ "group": Schema.optionalKey(Schema.String.annotate({ "description": "Weekly filter will include group identifier." })), "subgroup": Schema.optionalKey(Schema.String.annotate({ "description": "Weekly filter will include subgroup identifier." })) }).annotate({ "description": "Represents a weekly report filter." })
export type InvoicingInfo = { readonly "invoiceId"?: string, readonly "manuallyInvoiced"?: boolean }
export const InvoicingInfo = Schema.Struct({ "invoiceId": Schema.optionalKey(Schema.String), "manuallyInvoiced": Schema.optionalKey(Schema.Boolean) }).annotate({ "description": "Expense's invoicing info." })
export type AuditLogDtoV1 = { readonly "action"?: "CREATE_TIME_PERSONAL_TIMER" | "CREATE_TIME_PERSONAL_MANUAL" | "CREATE_TIME_IMPORT" | "CREATE_TIME_KIOSK" | "CREATE_TIME_FOR_OTHER" | "RESTORE_TIME" | "RESTORE_TIME_FOR_OTHER" | "UPDATE_TIME_PERSONAL" | "UPDATE_TIME_FOR_OTHER" | "DELETE_TIME_PERSONAL" | "DELETE_TIME_FOR_OTHER" | "CREATE_PROJECT" | "CREATE_PROJECT_IMPORT" | "CREATE_PROJECT_QUICKBOOKS" | "UPDATE_PROJECT" | "DELETE_PROJECT" | "CREATE_TASK" | "CREATE_TASK_IMPORT" | "UPDATE_TASK" | "DELETE_TASK" | "CREATE_CLIENT" | "CREATE_CLIENT_IMPORT" | "CREATE_CLIENT_QUICKBOOKS" | "UPDATE_CLIENT" | "DELETE_CLIENT" | "CREATE_TAG" | "CREATE_TAG_IMPORT" | "UPDATE_TAG" | "DELETE_TAG" | "CREATE_EXPENSE" | "CREATE_EXPENSE_FOR_OTHER" | "RESTORE_EXPENSE" | "RESTORE_EXPENSE_FOR_OTHER" | "UPDATE_EXPENSE" | "UPDATE_EXPENSE_FOR_OTHER" | "DELETE_EXPENSE" | "DELETE_EXPENSE_FOR_OTHER", readonly "content"?: string, readonly "previousContent"?: string, readonly "timestamp"?: string, readonly "userEmail"?: string, readonly "userId"?: string, readonly "userName"?: string, readonly "workspaceId"?: string }
export const AuditLogDtoV1 = Schema.Struct({ "action": Schema.optionalKey(Schema.Literals(["CREATE_TIME_PERSONAL_TIMER", "CREATE_TIME_PERSONAL_MANUAL", "CREATE_TIME_IMPORT", "CREATE_TIME_KIOSK", "CREATE_TIME_FOR_OTHER", "RESTORE_TIME", "RESTORE_TIME_FOR_OTHER", "UPDATE_TIME_PERSONAL", "UPDATE_TIME_FOR_OTHER", "DELETE_TIME_PERSONAL", "DELETE_TIME_FOR_OTHER", "CREATE_PROJECT", "CREATE_PROJECT_IMPORT", "CREATE_PROJECT_QUICKBOOKS", "UPDATE_PROJECT", "DELETE_PROJECT", "CREATE_TASK", "CREATE_TASK_IMPORT", "UPDATE_TASK", "DELETE_TASK", "CREATE_CLIENT", "CREATE_CLIENT_IMPORT", "CREATE_CLIENT_QUICKBOOKS", "UPDATE_CLIENT", "DELETE_CLIENT", "CREATE_TAG", "CREATE_TAG_IMPORT", "UPDATE_TAG", "DELETE_TAG", "CREATE_EXPENSE", "CREATE_EXPENSE_FOR_OTHER", "RESTORE_EXPENSE", "RESTORE_EXPENSE_FOR_OTHER", "UPDATE_EXPENSE", "UPDATE_EXPENSE_FOR_OTHER", "DELETE_EXPENSE", "DELETE_EXPENSE_FOR_OTHER"]).annotate({ "description": "Represents an audit log action type." })), "content": Schema.optionalKey(Schema.String.annotate({ "description": "Represents the current value of the modified entity" })), "previousContent": Schema.optionalKey(Schema.String.annotate({ "description": "Represents the previous value of the modified entity." })), "timestamp": Schema.optionalKey(Schema.String.annotate({ "description": "Represents a timestamp of when the audit log entry was created." })), "userEmail": Schema.optionalKey(Schema.String.annotate({ "description": "Represents the email address of the user." })), "userId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents a user identifier across the system." })), "userName": Schema.optionalKey(Schema.String.annotate({ "description": "Represents the name of the user." })), "workspaceId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents a workspace identifier across the system." })) })
export type Authors = { readonly "authorIds": ReadonlyArray<string>, readonly "contains": "CONTAINS" | "DOES_NOT_CONTAIN" }
export const Authors = Schema.Struct({ "authorIds": Schema.Array(Schema.String.annotate({ "description": "Represents a set of author user ids. Include \"SYSTEM\" in this set to retrieve system related audit logs." })).annotate({ "description": "Represents a set of author user ids. Include \"SYSTEM\" in this set to retrieve system related audit logs." }).check(Schema.isUnique()), "contains": Schema.Literals(["CONTAINS", "DOES_NOT_CONTAIN"]) }).annotate({ "description": "Represents the audit log author filter." })
export type InvoiceItemDto = { readonly "amount"?: number, readonly "applyTaxes"?: ApplyTaxes, readonly "description"?: string, readonly "expenseIds"?: ReadonlyArray<string>, readonly "importType"?: "NOT_IMPORTED" | "TIME_ENTRY_IMPORT" | "EXPENSE_IMPORT", readonly "itemType"?: string, readonly "order"?: number, readonly "quantity"?: number, readonly "timeEntryIds"?: ReadonlyArray<string>, readonly "unitPrice"?: number }
export const InvoiceItemDto = Schema.Struct({ "amount": Schema.optionalKey(Schema.Number.annotate({ "description": "Represents item amount.", "format": "int64" }).check(Schema.isInt())), "applyTaxes": Schema.optionalKey(ApplyTaxes), "description": Schema.optionalKey(Schema.String.annotate({ "description": "Represents an invoice item description." })), "expenseIds": Schema.optionalKey(Schema.Array(Schema.String.annotate({ "description": "Represents a list of imported expense ids." })).annotate({ "description": "Represents a list of imported expense ids." })), "importType": Schema.optionalKey(Schema.Literals(["NOT_IMPORTED", "TIME_ENTRY_IMPORT", "EXPENSE_IMPORT"]).annotate({ "description": "Represents the invoice item import type." })), "itemType": Schema.optionalKey(Schema.String.annotate({ "description": "Represents item type." })), "order": Schema.optionalKey(Schema.Number.annotate({ "description": "Represents an integer.", "format": "int32" }).check(Schema.isInt())), "quantity": Schema.optionalKey(Schema.Number.annotate({ "description": "Represents item quantity.", "format": "int64" }).check(Schema.isInt())), "timeEntryIds": Schema.optionalKey(Schema.Array(Schema.String.annotate({ "description": "Represents a list of imported time entry ids." })).annotate({ "description": "Represents a list of imported time entry ids." })), "unitPrice": Schema.optionalKey(Schema.Number.annotate({ "description": "Represents item unit price.", "format": "int64" }).check(Schema.isInt())) }).annotate({ "description": "Represents a list of invoice item datatransfer objects." })
export type RoleDtoV1 = { readonly "id"?: string, readonly "name"?: string, readonly "source"?: AuthorizationSourceDtoV1 }
export const RoleDtoV1 = Schema.Struct({ "id": Schema.optionalKey(Schema.String.annotate({ "description": "Represents role identifier across the system." })), "name": Schema.optionalKey(Schema.String.annotate({ "description": "Represents a role name." })), "source": Schema.optionalKey(AuthorizationSourceDtoV1) }).annotate({ "description": "Represents a role data transfer object." })
export type ImportTimeEntriesAndExpensesRequestV1 = { readonly "expenseFieldsForDetailedGroup"?: ReadonlyArray<"PROJECT" | "TASK" | "CATEGORY" | "NOTE" | "DATE" | "USER">, readonly "expensesGroupBy"?: "CATEGORY" | "PROJECT" | "USER", readonly "expensesGroupType"?: "GROUPED" | "DETAILED", readonly "from": string, readonly "importExpenses": boolean, readonly "projectFilter": ContainsArchivedFilterRequest, readonly "roundTimeEntryDuration"?: boolean, readonly "timeEntryFieldsForDetailedGroup"?: ReadonlyArray<"PROJECT" | "TASK" | "TAGS" | "DESCRIPTION" | "DATE" | "USER">, readonly "timeEntryGroupType": "SINGLE_ITEM" | "GROUPED" | "DETAILED", readonly "timeEntryPrimaryGroupBy"?: "USER" | "PROJECT" | "DATE", readonly "timeEntrySecondaryGroupBy"?: "PROJECT" | "USER" | "TASK" | "DATE" | "DESCRIPTION" | "NONE", readonly "to": string }
export const ImportTimeEntriesAndExpensesRequestV1 = Schema.Struct({ "expenseFieldsForDetailedGroup": Schema.optionalKey(Schema.Array(Schema.Literals(["PROJECT", "TASK", "CATEGORY", "NOTE", "DATE", "USER"]).annotate({ "description": "Represents a set of expense fields to include when using the DETAILED expense grouping type." })).annotate({ "description": "Represents a set of expense fields to include when using the DETAILED expense grouping type." }).check(Schema.isUnique())), "expensesGroupBy": Schema.optionalKey(Schema.Literals(["CATEGORY", "PROJECT", "USER"]).annotate({ "description": "Represents a group field when using the GROUPED expense group type." })), "expensesGroupType": Schema.optionalKey(Schema.Literals(["GROUPED", "DETAILED"]).annotate({ "description": "Represents an expense group type." })), "from": Schema.String.annotate({ "description": "Represents date and time in the yyyy-MM-ddThh:mm:ssZ format." }), "importExpenses": Schema.Boolean.annotate({ "description": "Indicates if billable expenses should be imported alongside time entries." }), "projectFilter": ContainsArchivedFilterRequest, "roundTimeEntryDuration": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates if imported time entry durations should be rounded to the nearest 15 minute interval." })), "timeEntryFieldsForDetailedGroup": Schema.optionalKey(Schema.Array(Schema.Literals(["PROJECT", "TASK", "TAGS", "DESCRIPTION", "DATE", "USER"]).annotate({ "description": "Represents a set of time entry fields to include when using DETAILED time entry grouping type." })).annotate({ "description": "Represents a set of time entry fields to include when using DETAILED time entry grouping type." }).check(Schema.isUnique())), "timeEntryGroupType": Schema.Literals(["SINGLE_ITEM", "GROUPED", "DETAILED"]).annotate({ "description": "Represents a time entry group type." }), "timeEntryPrimaryGroupBy": Schema.optionalKey(Schema.Literals(["USER", "PROJECT", "DATE"]).annotate({ "description": "Represents a primary group field when using the GROUPED time entry grouping type." })), "timeEntrySecondaryGroupBy": Schema.optionalKey(Schema.Literals(["PROJECT", "USER", "TASK", "DATE", "DESCRIPTION", "NONE"]).annotate({ "description": "Represents a secondary group field when using the GROUPED time entry grouping type. Should not have the same grouping type as the primary group field." })), "to": Schema.String.annotate({ "description": "Represents date and time in the yyyy-MM-ddThh:mm:ssZ format." }) })
export type GetUserTotalsRequestV1 = { readonly "end": string, readonly "page"?: number, readonly "pageSize"?: number, readonly "search"?: string, readonly "start": string, readonly "statusFilter"?: "PUBLISHED" | "UNPUBLISHED" | "ALL", readonly "userFilter"?: ContainsUsersFilterRequestV1, readonly "userGroupFilter"?: ContainsUserGroupFilterRequestV1 }
export const GetUserTotalsRequestV1 = Schema.Struct({ "end": Schema.String.annotate({ "description": "Represents an end date in the yyyy-MM-ddThh:mm:ssZ format.", "format": "date-time" }), "page": Schema.optionalKey(Schema.Number.annotate({ "description": "Page number.", "format": "int32" }).check(Schema.isInt())), "pageSize": Schema.optionalKey(Schema.Number.annotate({ "description": "Page size.", "format": "int32" }).check(Schema.isInt()).check(Schema.isLessThanOrEqualTo(200))), "search": Schema.optionalKey(Schema.String.annotate({ "description": "Represents the keyword for searching users by name or email." })), "start": Schema.String.annotate({ "description": "Represents a start date in the yyyy-MM-ddThh:mm:ssZ format.", "format": "date-time" }), "statusFilter": Schema.optionalKey(Schema.Literals(["PUBLISHED", "UNPUBLISHED", "ALL"]).annotate({ "description": "Filters assignments by status." })), "userFilter": Schema.optionalKey(ContainsUsersFilterRequestV1), "userGroupFilter": Schema.optionalKey(ContainsUserGroupFilterRequestV1) })
export type PublishAssignmentsRequestV1 = { readonly "end": string, readonly "notifyUsers"?: boolean, readonly "search"?: string, readonly "start": string, readonly "userFilter"?: ContainsUsersFilterRequestV1, readonly "userGroupFilter"?: ContainsUserGroupFilterRequestV1, readonly "viewType"?: "PROJECTS" | "TEAM" | "ALL" }
export const PublishAssignmentsRequestV1 = Schema.Struct({ "end": Schema.String.annotate({ "description": "Represents end date in yyyy-MM-ddThh:mm:ssZ format." }), "notifyUsers": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether to notify users when assignment is published." })), "search": Schema.optionalKey(Schema.String.annotate({ "description": "Represents a search string." })), "start": Schema.String.annotate({ "description": "Represents start date in yyyy-MM-ddThh:mm:ssZ format." }), "userFilter": Schema.optionalKey(ContainsUsersFilterRequestV1), "userGroupFilter": Schema.optionalKey(ContainsUserGroupFilterRequestV1), "viewType": Schema.optionalKey(Schema.Literals(["PROJECTS", "TEAM", "ALL"]).annotate({ "description": "Represents view type." })) })
export type AssignmentCreateRequestV1 = { readonly "billable"?: boolean, readonly "end": string, readonly "hoursPerDay": number, readonly "includeNonWorkingDays"?: boolean, readonly "note"?: string, readonly "projectId": string, readonly "recurringAssignment"?: CreateRecurringAssignmentRequestV1, readonly "start": string, readonly "startTime"?: string, readonly "taskId"?: string, readonly "userId": string }
export const AssignmentCreateRequestV1 = Schema.Struct({ "billable": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether assignment is billable or not." })), "end": Schema.String.annotate({ "description": "Represents an end date in the yyyy-MM-ddThh:mm:ssZ format." }), "hoursPerDay": Schema.Number.annotate({ "description": "Represents assignment total hours per day.", "format": "double" }).check(Schema.isFinite()), "includeNonWorkingDays": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether to include non-working days or not." })), "note": Schema.optionalKey(Schema.String.annotate({ "description": "Represents an assignment note." }).check(Schema.isMinLength(0)).check(Schema.isMaxLength(100))), "projectId": Schema.String.annotate({ "description": "Represents a project identifier across the system." }).check(Schema.isMinLength(1)), "recurringAssignment": Schema.optionalKey(CreateRecurringAssignmentRequestV1), "start": Schema.String.annotate({ "description": "Represents a start date in the yyyy-MM-ddThh:mm:ssZ format." }), "startTime": Schema.optionalKey(Schema.String.annotate({ "description": "Represents a start time in the hh:mm:ss format." })), "taskId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents a task identifier across the system." })), "userId": Schema.String.annotate({ "description": "Represents a user identifier across the system." }).check(Schema.isMinLength(1)) })
export type CustomFieldDtoV1 = { readonly "allowedValues"?: ReadonlyArray<string>, readonly "description"?: string, readonly "entityType"?: string, readonly "id"?: string, readonly "name"?: string, readonly "onlyAdminCanEdit"?: boolean, readonly "placeholder"?: string, readonly "projectDefaultValues"?: ReadonlyArray<CustomFieldDefaultValuesDtoV1>, readonly "required"?: boolean, readonly "status"?: string, readonly "type"?: string, readonly "workspaceDefaultValue"?: {  }, readonly "workspaceId"?: string }
export const CustomFieldDtoV1 = Schema.Struct({ "allowedValues": Schema.optionalKey(Schema.Array(Schema.String.annotate({ "description": "Represents a list of custom field's allowed values." })).annotate({ "description": "Represents a list of custom field's allowed values." })), "description": Schema.optionalKey(Schema.String.annotate({ "description": "Represents custom field description." })), "entityType": Schema.optionalKey(Schema.String.annotate({ "description": "Represents custom field entity type" })), "id": Schema.optionalKey(Schema.String.annotate({ "description": "Represents custom field identifier across the system." })), "name": Schema.optionalKey(Schema.String.annotate({ "description": "Represents custom field name." })), "onlyAdminCanEdit": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Flag to set whether custom field is modifiable only by admin users." })), "placeholder": Schema.optionalKey(Schema.String.annotate({ "description": "Represents custom field placeholder value." })), "projectDefaultValues": Schema.optionalKey(Schema.Array(CustomFieldDefaultValuesDtoV1).annotate({ "description": "Represents a list of custom field default values data transfer objects." })), "required": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Flag to set whether custom field is mandatory or not." })), "status": Schema.optionalKey(Schema.String.annotate({ "description": "Represents custom field status" })), "type": Schema.optionalKey(Schema.String.annotate({ "description": "Represents custom field type." })), "workspaceDefaultValue": Schema.optionalKey(Schema.Struct({  }).annotate({ "description": "Represents a custom field's default value in the workspace." })), "workspaceId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents workspace identifier across the system." })) })
export type UserCustomFieldValueDtoV1 = { readonly "customFieldId"?: string, readonly "customFieldName"?: string, readonly "customFieldType"?: CustomFieldType, readonly "userId"?: string, readonly "value"?: {  } }
export const UserCustomFieldValueDtoV1 = Schema.Struct({ "customFieldId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents custom field identifier across the system." })), "customFieldName": Schema.optionalKey(Schema.String.annotate({ "description": "Represents custom field name." })), "customFieldType": Schema.optionalKey(CustomFieldType), "userId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents user identifier across the system." })), "value": Schema.optionalKey(Schema.Struct({  }).annotate({ "description": "Represents custom field value." })) }).annotate({ "description": "Represents a list of value objects for user’s custom fields." })
export type HolidayDtoV1 = { readonly "automaticTimeEntryCreation"?: boolean, readonly "datePeriod"?: DatePeriod, readonly "everyoneIncludingNew"?: boolean, readonly "id"?: string, readonly "name"?: string, readonly "occursAnnually"?: boolean, readonly "projectId"?: string, readonly "taskId"?: string, readonly "userGroupIds"?: ReadonlyArray<string>, readonly "userIds"?: ReadonlyArray<string>, readonly "workspaceId"?: string }
export const HolidayDtoV1 = Schema.Struct({ "automaticTimeEntryCreation": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates that time entries will be automatically created for this holiday." })), "datePeriod": Schema.optionalKey(DatePeriod), "everyoneIncludingNew": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether the holiday is shown to new users." })), "id": Schema.optionalKey(Schema.String.annotate({ "description": "Represents holiday identifier across the system." })), "name": Schema.optionalKey(Schema.String.annotate({ "description": "Represents the name of the holiday." })), "occursAnnually": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether the holiday occurs annually." })), "projectId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents projectId for automatic time entry creation." })), "taskId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents taskId for automatic time entry creation." })), "userGroupIds": Schema.optionalKey(Schema.Array(Schema.String.annotate({ "description": "Indicates which user groups are included." })).annotate({ "description": "Indicates which user groups are included." }).check(Schema.isUnique())), "userIds": Schema.optionalKey(Schema.Array(Schema.String.annotate({ "description": "Indicates which users are included." })).annotate({ "description": "Indicates which users are included." }).check(Schema.isUnique())), "workspaceId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents workspace identifier across the system." })) })
export type ApprovalRequestDtoV1 = { readonly "creator"?: ApprovalRequestCreatorDtoV1, readonly "dateRange"?: DateRangeDto, readonly "id"?: string, readonly "owner"?: ApprovalRequestOwnerDtoV1, readonly "status"?: ApprovalRequestStatusDtoV1, readonly "workspaceId"?: string }
export const ApprovalRequestDtoV1 = Schema.Struct({ "creator": Schema.optionalKey(ApprovalRequestCreatorDtoV1), "dateRange": Schema.optionalKey(DateRangeDto), "id": Schema.optionalKey(Schema.String.annotate({ "description": "Represents approval request identifier across the workspace." })), "owner": Schema.optionalKey(ApprovalRequestOwnerDtoV1), "status": Schema.optionalKey(ApprovalRequestStatusDtoV1), "workspaceId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents workspace identifier across the system." })) }).annotate({ "description": "Represents a valid approval request data transfer object." })
export type AssignmentHydratedDtoV1 = { readonly "billable"?: boolean, readonly "clientId"?: string, readonly "clientName"?: string, readonly "hoursPerDay"?: number, readonly "id"?: string, readonly "note"?: string, readonly "period"?: DateRangeDto, readonly "projectArchived"?: boolean, readonly "projectBillable"?: boolean, readonly "projectColor"?: string, readonly "projectId"?: string, readonly "projectName"?: string, readonly "startTime"?: string, readonly "taskId"?: string, readonly "taskName"?: string, readonly "userId"?: string, readonly "userName"?: string, readonly "workspaceId"?: string }
export const AssignmentHydratedDtoV1 = Schema.Struct({ "billable": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether assignment is billable or not." })), "clientId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents client identifier across the system." })), "clientName": Schema.optionalKey(Schema.String.annotate({ "description": "Represents project name." })), "hoursPerDay": Schema.optionalKey(Schema.Number.annotate({ "description": "Represents number of hours per day as double.", "format": "double" }).check(Schema.isFinite())), "id": Schema.optionalKey(Schema.String.annotate({ "description": "Represents assignment identifier across the system." })), "note": Schema.optionalKey(Schema.String.annotate({ "description": "Represents assignment note." })), "period": Schema.optionalKey(DateRangeDto), "projectArchived": Schema.optionalKey(Schema.Boolean), "projectBillable": Schema.optionalKey(Schema.Boolean), "projectColor": Schema.optionalKey(Schema.String.annotate({ "description": "Color format ^#(?:[0-9a-fA-F]{6}){1}$. Explanation: A valid color code should start with '#' and consist of six hexadecimal characters, representing a color in hexadecimal format. Color value is in standard RGB hexadecimal format." })), "projectId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents project identifier across the system." })), "projectName": Schema.optionalKey(Schema.String.annotate({ "description": "Represents project name." })), "startTime": Schema.optionalKey(Schema.String.annotate({ "description": "Represents start time in hh:mm:ss format." })), "taskId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents task identifier across the system." })), "taskName": Schema.optionalKey(Schema.String.annotate({ "description": "Represents task name." })), "userId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents user identifier across the system." })), "userName": Schema.optionalKey(Schema.String.annotate({ "description": "Represents user name." })), "workspaceId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents workspace identifier across the system." })) })
export type AutomaticTimeEntryCreationDto = { readonly "defaultEntities"?: DefaultEntitiesDto, readonly "enabled"?: boolean }
export const AutomaticTimeEntryCreationDto = Schema.Struct({ "defaultEntities": Schema.optionalKey(DefaultEntitiesDto), "enabled": Schema.optionalKey(Schema.Boolean) }).annotate({ "description": "Represents automatic time entry creation settings." })
export type AutomaticTimeEntryCreationRequest = { readonly "defaultEntities": DefaultEntitiesRequest, readonly "enabled"?: boolean }
export const AutomaticTimeEntryCreationRequest = Schema.Struct({ "defaultEntities": DefaultEntitiesRequest, "enabled": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates that automatic time entry creation is enabled." })) }).annotate({ "description": "Provides automatic time entry creation settings." })
export type EntityCreationPermissionsDtoV1 = { readonly "whoCanCreateProjectsAndClients"?: EntityCreationPermission, readonly "whoCanCreateTags"?: EntityCreationPermission, readonly "whoCanCreateTasks"?: EntityCreationPermission }
export const EntityCreationPermissionsDtoV1 = Schema.Struct({ "whoCanCreateProjectsAndClients": Schema.optionalKey(EntityCreationPermission), "whoCanCreateTags": Schema.optionalKey(EntityCreationPermission), "whoCanCreateTasks": Schema.optionalKey(EntityCreationPermission) }).annotate({ "description": "Represents an entity creation permission object." })
export type ExpenseCategoriesWithCountDtoV1 = { readonly "categories"?: ReadonlyArray<ExpenseCategoryDtoV1>, readonly "count"?: number }
export const ExpenseCategoriesWithCountDtoV1 = Schema.Struct({ "categories": Schema.optionalKey(Schema.Array(ExpenseCategoryDtoV1).annotate({ "description": "Represents a list of expense categories data transfer object." })), "count": Schema.optionalKey(Schema.Number.annotate({ "description": "Indicates the number of expense categories returned.", "format": "int32" }).check(Schema.isInt())) })
export type MembershipRequest = { readonly "hourlyRate"?: HourlyRateRequest, readonly "membershipStatus"?: "PENDING" | "ACTIVE" | "DECLINED" | "INACTIVE" | "ALL", readonly "membershipType"?: "WORKSPACE" | "PROJECT" | "USERGROUP", readonly "userId"?: string }
export const MembershipRequest = Schema.Struct({ "hourlyRate": Schema.optionalKey(HourlyRateRequest), "membershipStatus": Schema.optionalKey(Schema.Literals(["PENDING", "ACTIVE", "DECLINED", "INACTIVE", "ALL"]).annotate({ "description": "Represents a membership status enum." })), "membershipType": Schema.optionalKey(Schema.Literals(["WORKSPACE", "PROJECT", "USERGROUP"]).annotate({ "description": "Represents membership type enum." })), "userId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents user identifier across the system." })) }).annotate({ "description": "Represents a list of membership request objects." })
export type TaskRequest = { readonly "assigneeId"?: string, readonly "assigneeIds"?: ReadonlyArray<string>, readonly "billable"?: boolean, readonly "budgetEstimate"?: number, readonly "costRate"?: CostRateRequest, readonly "estimate"?: string, readonly "hourlyRate"?: HourlyRateRequest, readonly "id"?: string, readonly "name": string, readonly "projectId"?: string, readonly "status"?: string, readonly "userGroupIds"?: ReadonlyArray<string> }
export const TaskRequest = Schema.Struct({ "assigneeId": Schema.optionalKey(Schema.String), "assigneeIds": Schema.optionalKey(Schema.Array(Schema.String.annotate({ "description": "Represents list of assignee ids for the task." })).annotate({ "description": "Represents list of assignee ids for the task." }).check(Schema.isUnique())), "billable": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Flag to set whether task is billable or not" })), "budgetEstimate": Schema.optionalKey(Schema.Number.annotate({ "format": "int64" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0))), "costRate": Schema.optionalKey(CostRateRequest), "estimate": Schema.optionalKey(Schema.String.annotate({ "description": "Represents a task duration estimate." })), "hourlyRate": Schema.optionalKey(HourlyRateRequest), "id": Schema.optionalKey(Schema.String.annotate({ "description": "Represents task identifier across the system." })), "name": Schema.String.annotate({ "description": "Represents task name." }), "projectId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents project identifier across the system." })), "status": Schema.optionalKey(Schema.String), "userGroupIds": Schema.optionalKey(Schema.Array(Schema.String.annotate({ "description": "Represents list of user group ids for the task." })).annotate({ "description": "Represents list of user group ids for the task." }).check(Schema.isUnique())) }).annotate({ "description": "Represents a list of task request objects." })
export type UpdateProjectRequest = { readonly "archived"?: boolean, readonly "billable"?: boolean, readonly "clientId"?: string, readonly "color"?: string, readonly "costRate"?: CostRateRequestV1, readonly "hourlyRate"?: HourlyRateRequestV1, readonly "isPublic"?: boolean, readonly "name"?: string, readonly "note"?: string }
export const UpdateProjectRequest = Schema.Struct({ "archived": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether project is archived or not." })), "billable": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether project is billable or not." })), "clientId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents client identifier across the system." })), "color": Schema.optionalKey(Schema.String.annotate({ "description": "Color format ^#(?:[0-9a-fA-F]{6}){1}$. Explanation: A valid color code should start with '#' and consist of six hexadecimal characters, representing a color in hexadecimal format. Color value is in standard RGB hexadecimal format." }).check(Schema.isPattern(new RegExp("^#(?:[0-9a-fA-F]{6}){1}$")))), "costRate": Schema.optionalKey(CostRateRequestV1), "hourlyRate": Schema.optionalKey(HourlyRateRequestV1), "isPublic": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether project is public or not." })), "name": Schema.optionalKey(Schema.String.annotate({ "description": "Represents a project name." }).check(Schema.isMinLength(2)).check(Schema.isMaxLength(250))), "note": Schema.optionalKey(Schema.String.annotate({ "description": "Represents project note." }).check(Schema.isMaxLength(16384))) })
export type UserIdWithRatesRequest = { readonly "costRate"?: CostRateRequestV1, readonly "hourlyRate"?: HourlyRateRequestV1, readonly "userId": string }
export const UserIdWithRatesRequest = Schema.Struct({ "costRate": Schema.optionalKey(CostRateRequestV1), "hourlyRate": Schema.optionalKey(HourlyRateRequestV1), "userId": Schema.String.annotate({ "description": "Represents user identifier across the system." }) }).annotate({ "description": "Represents a list of users with id and rates request objects." })
export type InvoicesListDtoV1 = { readonly "invoices"?: ReadonlyArray<InvoiceDtoV1>, readonly "total"?: number }
export const InvoicesListDtoV1 = Schema.Struct({ "invoices": Schema.optionalKey(Schema.Array(InvoiceDtoV1).annotate({ "description": "Represents a list of invoices." })), "total": Schema.optionalKey(Schema.Number.annotate({ "description": "Represents the total invoice count.", "format": "int64" }).check(Schema.isInt())) })
export type InvoiceSettingsDtoV1 = { readonly "defaults"?: InvoiceDefaultSettingsDto, readonly "exportFields"?: InvoiceExportFields, readonly "labels"?: LabelsCustomization }
export const InvoiceSettingsDtoV1 = Schema.Struct({ "defaults": Schema.optionalKey(InvoiceDefaultSettingsDto), "exportFields": Schema.optionalKey(InvoiceExportFields), "labels": Schema.optionalKey(LabelsCustomization) })
export type UpdateInvoiceSettingsRequestV1 = { readonly "defaults"?: InvoiceDefaultSettingsRequestV1, readonly "exportFields"?: InvoiceExportFieldsRequest, readonly "labels": LabelsCustomizationRequest }
export const UpdateInvoiceSettingsRequestV1 = Schema.Struct({ "defaults": Schema.optionalKey(InvoiceDefaultSettingsRequestV1), "exportFields": Schema.optionalKey(InvoiceExportFieldsRequest), "labels": LabelsCustomizationRequest })
export type PageableCollectionLogBinDocumentDto = { readonly "response"?: ReadonlyArray<LogBinDocumentDto> }
export const PageableCollectionLogBinDocumentDto = Schema.Struct({ "response": Schema.optionalKey(Schema.Array(LogBinDocumentDto)) })
export type SchedulingProjectsTotalsDtoV1 = { readonly "assignments"?: ReadonlyArray<AssignmentPerDayDto>, readonly "clientName"?: string, readonly "milestones"?: ReadonlyArray<MilestoneDto>, readonly "projectArchived"?: boolean, readonly "projectBillable"?: boolean, readonly "projectColor"?: string, readonly "projectId"?: string, readonly "projectName"?: string, readonly "taskId"?: string, readonly "taskName"?: string, readonly "totalHours"?: number, readonly "workspaceId"?: string }
export const SchedulingProjectsTotalsDtoV1 = Schema.Struct({ "assignments": Schema.optionalKey(Schema.Array(AssignmentPerDayDto).annotate({ "description": "Represents a list of assignment per day objects." })), "clientName": Schema.optionalKey(Schema.String.annotate({ "description": "Represents project name." })), "milestones": Schema.optionalKey(Schema.Array(MilestoneDto).annotate({ "description": "Represents a list of milestone objects." })), "projectArchived": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether project is archived or not." })), "projectBillable": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether project is billable or not." })), "projectColor": Schema.optionalKey(Schema.String.annotate({ "description": "Color format ^#(?:[0-9a-fA-F]{6}){1}$. Explanation: A valid color code should start with '#' and consist of six hexadecimal characters, representing a color in hexadecimal format. Color value is in standard RGB hexadecimal format." })), "projectId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents project identifier across the system." })), "projectName": Schema.optionalKey(Schema.String.annotate({ "description": "Represents project name." })), "taskId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents task identifier across the system." })), "taskName": Schema.optionalKey(Schema.String.annotate({ "description": "Represents task name." })), "totalHours": Schema.optionalKey(Schema.Number.annotate({ "description": "Represents project total hours as double.", "format": "double" }).check(Schema.isFinite())), "workspaceId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents workspace identifier across the system." })) })
export type TimeOffRequestPeriodDto = { readonly "halfDay"?: boolean, readonly "halfDayHours"?: Period, readonly "halfDayPeriod"?: string, readonly "period"?: Period }
export const TimeOffRequestPeriodDto = Schema.Struct({ "halfDay": Schema.optionalKey(Schema.Boolean), "halfDayHours": Schema.optionalKey(Period), "halfDayPeriod": Schema.optionalKey(Schema.String), "period": Schema.optionalKey(Period) }).annotate({ "description": "Represents the period the time off request." })
export type TimeOffRequestPeriodV1Request = { readonly "halfDayPeriod"?: "FIRST_HALF" | "SECOND_HALF" | "NOT_DEFINED", readonly "isHalfDay"?: boolean, readonly "period": PeriodV1Request, readonly "timeOffHalfDayPeriod"?: "FIRST_HALF" | "SECOND_HALF" | "NOT_DEFINED" }
export const TimeOffRequestPeriodV1Request = Schema.Struct({ "halfDayPeriod": Schema.optionalKey(Schema.Literals(["FIRST_HALF", "SECOND_HALF", "NOT_DEFINED"]).annotate({ "description": "Represents the half day period." })), "isHalfDay": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether time off is half day." })), "period": PeriodV1Request, "timeOffHalfDayPeriod": Schema.optionalKey(Schema.Literals(["FIRST_HALF", "SECOND_HALF", "NOT_DEFINED"])) }).annotate({ "description": "Provide the period you would like to use for creating the time off request. If `timeZone` isn't set, should be aligned with time zone for user in settings. Can be shifted from user time zone with explicit setting of `timeZone`." })
export type TemplateRequest = { readonly "name": string, readonly "projectsAndTasks": ReadonlyArray<ProjectTaskTupleRequest>, readonly "timeEntryIds"?: ReadonlyArray<string>, readonly "weekStart"?: string }
export const TemplateRequest = Schema.Struct({ "name": Schema.String.annotate({ "description": "Represents a template name." }).check(Schema.isMinLength(1)), "projectsAndTasks": Schema.Array(ProjectTaskTupleRequest).annotate({ "description": "Represents a list of template's projects and tasks." }), "timeEntryIds": Schema.optionalKey(Schema.Array(Schema.String.annotate({ "description": "Represents a set of template time entry ids." })).annotate({ "description": "Represents a set of template time entry ids." }).check(Schema.isUnique())), "weekStart": Schema.optionalKey(Schema.String.annotate({ "description": "Represents a date of the starting day of the week in the yyyy-MM-dd format.", "format": "date" })) })
export type MembershipDtoV1 = { readonly "costRate"?: RateDtoV1, readonly "hourlyRate"?: HourlyRateDtoV1, readonly "membershipStatus"?: "PENDING" | "ACTIVE" | "DECLINED" | "INACTIVE" | "ALL", readonly "membershipType"?: "WORKSPACE" | "PROJECT" | "USERGROUP", readonly "targetId"?: string, readonly "userId"?: string }
export const MembershipDtoV1 = Schema.Struct({ "costRate": Schema.optionalKey(RateDtoV1), "hourlyRate": Schema.optionalKey(HourlyRateDtoV1), "membershipStatus": Schema.optionalKey(Schema.Literals(["PENDING", "ACTIVE", "DECLINED", "INACTIVE", "ALL"]).annotate({ "description": "Represents a membership status enum." })), "membershipType": Schema.optionalKey(Schema.Literals(["WORKSPACE", "PROJECT", "USERGROUP"]).annotate({ "description": "Represents membership type enum." })), "targetId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents target identifier across the system." })), "userId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents user identifier across the system." })) }).annotate({ "description": "Represents a list of membership objects." })
export type AssignmentDtoV1 = { readonly "billable"?: boolean, readonly "excludeDays"?: ReadonlyArray<SchedulingExcludeDay>, readonly "hoursPerDay"?: number, readonly "id"?: string, readonly "includeNonWorkingDays"?: boolean, readonly "note"?: string, readonly "period"?: DateRangeDto, readonly "projectId"?: string, readonly "published"?: boolean, readonly "recurring"?: RecurringAssignmentDto, readonly "startTime"?: string, readonly "taskId"?: string, readonly "userId"?: string, readonly "workspaceId"?: string }
export const AssignmentDtoV1 = Schema.Struct({ "billable": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether assignment is billable or not." })), "excludeDays": Schema.optionalKey(Schema.Array(SchedulingExcludeDay).annotate({ "description": "Represents a list of excluded days objects" }).check(Schema.isUnique())), "hoursPerDay": Schema.optionalKey(Schema.Number.annotate({ "description": "Represents assignment total hours per day.", "format": "double" }).check(Schema.isFinite())), "id": Schema.optionalKey(Schema.String.annotate({ "description": "Represents assignment identifier across the system." })), "includeNonWorkingDays": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether assignment should include non-working days or not." })), "note": Schema.optionalKey(Schema.String.annotate({ "description": "Represents assignment note." })), "period": Schema.optionalKey(DateRangeDto), "projectId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents project identifier across the system." })), "published": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether assignment is published or not." })), "recurring": Schema.optionalKey(RecurringAssignmentDto), "startTime": Schema.optionalKey(Schema.String.annotate({ "description": "Represents start time in hh:mm:ss format." })), "taskId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents task identifier across the system." })), "userId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents user identifier across the system." })), "workspaceId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents workspace identifier across the system." })) })
export type UserSettingsDtoV1 = { readonly "alerts"?: boolean, readonly "approval"?: boolean, readonly "collapseAllProjectLists"?: boolean, readonly "dashboardPinToTop"?: boolean, readonly "dashboardSelection"?: "ME" | "TEAM", readonly "dashboardViewType"?: "PROJECT" | "BILLABILITY", readonly "dateFormat": string, readonly "groupSimilarEntriesDisabled"?: boolean, readonly "invoiceReminders"?: boolean, readonly "isCompactViewOn"?: boolean, readonly "lang"?: string, readonly "longRunning"?: boolean, readonly "multiFactorEnabled"?: boolean, readonly "myStartOfDay"?: string, readonly "onboarding"?: boolean, readonly "projectListCollapse"?: number, readonly "projectPickerTaskFilter"?: boolean, readonly "pto"?: boolean, readonly "reminders"?: boolean, readonly "scheduledReports"?: boolean, readonly "scheduling"?: boolean, readonly "sendNewsletter"?: boolean, readonly "showOnlyWorkingDays"?: boolean, readonly "summaryReportSettings"?: SummaryReportSettingsDtoV1, readonly "theme"?: "DARK" | "DEFAULT", readonly "timeFormat": "HOUR12" | "HOUR24", readonly "timeTrackingManual"?: boolean, readonly "timeZone": string, readonly "weekStart"?: "MONDAY" | "TUESDAY" | "WEDNESDAY" | "THURSDAY" | "FRIDAY" | "SATURDAY" | "SUNDAY", readonly "weeklyUpdates"?: boolean }
export const UserSettingsDtoV1 = Schema.Struct({ "alerts": Schema.optionalKey(Schema.Boolean), "approval": Schema.optionalKey(Schema.Boolean), "collapseAllProjectLists": Schema.optionalKey(Schema.Boolean), "dashboardPinToTop": Schema.optionalKey(Schema.Boolean), "dashboardSelection": Schema.optionalKey(Schema.Literals(["ME", "TEAM"])), "dashboardViewType": Schema.optionalKey(Schema.Literals(["PROJECT", "BILLABILITY"])), "dateFormat": Schema.String.annotate({ "description": "Represents a date format." }).check(Schema.isMinLength(1)), "groupSimilarEntriesDisabled": Schema.optionalKey(Schema.Boolean), "invoiceReminders": Schema.optionalKey(Schema.Boolean), "isCompactViewOn": Schema.optionalKey(Schema.Boolean), "lang": Schema.optionalKey(Schema.String), "longRunning": Schema.optionalKey(Schema.Boolean), "multiFactorEnabled": Schema.optionalKey(Schema.Boolean), "myStartOfDay": Schema.optionalKey(Schema.String), "onboarding": Schema.optionalKey(Schema.Boolean), "projectListCollapse": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt())), "projectPickerTaskFilter": Schema.optionalKey(Schema.Boolean), "pto": Schema.optionalKey(Schema.Boolean), "reminders": Schema.optionalKey(Schema.Boolean), "scheduledReports": Schema.optionalKey(Schema.Boolean), "scheduling": Schema.optionalKey(Schema.Boolean), "sendNewsletter": Schema.optionalKey(Schema.Boolean), "showOnlyWorkingDays": Schema.optionalKey(Schema.Boolean), "summaryReportSettings": Schema.optionalKey(SummaryReportSettingsDtoV1), "theme": Schema.optionalKey(Schema.Literals(["DARK", "DEFAULT"])), "timeFormat": Schema.Literals(["HOUR12", "HOUR24"]).annotate({ "description": "Represents a time format enum." }), "timeTrackingManual": Schema.optionalKey(Schema.Boolean), "timeZone": Schema.String.annotate({ "description": "Represents a valid timezone ID" }).check(Schema.isMinLength(1)), "weekStart": Schema.optionalKey(Schema.Literals(["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"]).annotate({ "description": "Represents a day of the week." })), "weeklyUpdates": Schema.optionalKey(Schema.Boolean) }).annotate({ "description": "Represents user settings object." })
export type ExpenseHydratedDto = { readonly "approvalRequestId"?: string, readonly "approvalStatus"?: "PENDING" | "APPROVED" | "UNSUBMITTED" | "REJECTED" | "WITHDRAWN_APPROVAL" | "WITHDRAWN_SUBMISSION", readonly "billable"?: boolean, readonly "category"?: ExpenseCategoryDto, readonly "currency"?: string, readonly "date"?: string, readonly "detailedApprovalStatus"?: "PENDING" | "APPROVED" | "UNSUBMITTED" | "REJECTED" | "WITHDRAWN_APPROVAL" | "WITHDRAWN_SUBMISSION", readonly "fileId"?: string, readonly "fileName"?: string, readonly "fileUrl"?: string, readonly "id"?: string, readonly "isLocked"?: boolean, readonly "locked"?: boolean, readonly "notes"?: string, readonly "project"?: ProjectInfoDto, readonly "quantity"?: number, readonly "task"?: TaskInfoDto, readonly "total"?: number, readonly "userId"?: string, readonly "workspaceId"?: string }
export const ExpenseHydratedDto = Schema.Struct({ "approvalRequestId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents approval request identifier across the system." })), "approvalStatus": Schema.optionalKey(Schema.Literals(["PENDING", "APPROVED", "UNSUBMITTED", "REJECTED", "WITHDRAWN_APPROVAL", "WITHDRAWN_SUBMISSION"]).annotate({ "description": "Represents the approval status of the expense" })), "billable": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether expense is billable or not." })), "category": Schema.optionalKey(ExpenseCategoryDto), "currency": Schema.optionalKey(Schema.String.annotate({ "description": "Represents a currency." })), "date": Schema.optionalKey(Schema.String.annotate({ "description": "Represents a date in yyyy-MM-dd format." })), "detailedApprovalStatus": Schema.optionalKey(Schema.Literals(["PENDING", "APPROVED", "UNSUBMITTED", "REJECTED", "WITHDRAWN_APPROVAL", "WITHDRAWN_SUBMISSION"]).annotate({ "description": "Represents a detailed approval status of the expense" })), "fileId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents file identifier across the system." })), "fileName": Schema.optionalKey(Schema.String.annotate({ "description": "Represents file name." })), "fileUrl": Schema.optionalKey(Schema.String.annotate({ "description": "Represents file URL." })), "id": Schema.optionalKey(Schema.String.annotate({ "description": "Represents expense identifier across the system." })), "isLocked": Schema.optionalKey(Schema.Boolean.annotate({ "writeOnly": true })), "locked": Schema.optionalKey(Schema.Boolean), "notes": Schema.optionalKey(Schema.String.annotate({ "description": "Represents notes for an expense." })), "project": Schema.optionalKey(ProjectInfoDto), "quantity": Schema.optionalKey(Schema.Number.annotate({ "description": "Represents expense quantity as double data type.", "format": "double" }).check(Schema.isFinite())), "task": Schema.optionalKey(TaskInfoDto), "total": Schema.optionalKey(Schema.Number.annotate({ "description": "Represents expense total as double data type.", "format": "double" }).check(Schema.isFinite())), "userId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents user identifier across the system." })), "workspaceId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents workspace identifier across the system." })) }).annotate({ "description": "Represents a list of expense hydrated data transfer objects." })
export type ExpenseHydratedDtoV1 = { readonly "billable"?: boolean, readonly "category"?: ExpenseCategoryDto, readonly "date"?: string, readonly "fileId"?: string, readonly "fileName"?: string, readonly "id"?: string, readonly "isLocked"?: boolean, readonly "locked"?: boolean, readonly "notes"?: string, readonly "project"?: ProjectInfoDto, readonly "quantity"?: number, readonly "task"?: TaskInfoDto, readonly "total"?: number, readonly "userId"?: string, readonly "workspaceId"?: string }
export const ExpenseHydratedDtoV1 = Schema.Struct({ "billable": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether expense is billable or not." })), "category": Schema.optionalKey(ExpenseCategoryDto), "date": Schema.optionalKey(Schema.String.annotate({ "description": "Represents a date in yyyy-MM-dd format." })), "fileId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents file identifier across the system." })), "fileName": Schema.optionalKey(Schema.String.annotate({ "description": "Represents file name." })), "id": Schema.optionalKey(Schema.String.annotate({ "description": "Represents expense identifier across the system." })), "isLocked": Schema.optionalKey(Schema.Boolean.annotate({ "writeOnly": true })), "locked": Schema.optionalKey(Schema.Boolean), "notes": Schema.optionalKey(Schema.String.annotate({ "description": "Represents notes for an expense." })), "project": Schema.optionalKey(ProjectInfoDto), "quantity": Schema.optionalKey(Schema.Number.annotate({ "description": "Represents expense quantity as double data type.", "format": "double" }).check(Schema.isFinite())), "task": Schema.optionalKey(TaskInfoDto), "total": Schema.optionalKey(Schema.Number.annotate({ "description": "Represents expense total as double data type.", "format": "double" }).check(Schema.isFinite())), "userId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents user identifier across the system." })), "workspaceId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents workspace identifier across the system." })) }).annotate({ "description": "Represent a list of hydrated expense objects." })
export type TaskDtoV1 = { readonly "assigneeId"?: string, readonly "assigneeIds"?: ReadonlyArray<string>, readonly "billable"?: boolean, readonly "budgetEstimate"?: number, readonly "costRate"?: RateDtoV1, readonly "duration"?: string, readonly "estimate"?: string, readonly "hourlyRate"?: RateDtoV1, readonly "id"?: string, readonly "name"?: string, readonly "projectId"?: string, readonly "status"?: TaskStatus, readonly "userGroupIds"?: ReadonlyArray<string> }
export const TaskDtoV1 = Schema.Struct({ "assigneeId": Schema.optionalKey(Schema.String), "assigneeIds": Schema.optionalKey(Schema.Array(Schema.String.annotate({ "description": "Represents list of assignee ids for the task." })).annotate({ "description": "Represents list of assignee ids for the task." }).check(Schema.isUnique())), "billable": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether a task is billable or not." })), "budgetEstimate": Schema.optionalKey(Schema.Number.annotate({ "description": "Represents a task budget estimate as long.", "format": "int64" }).check(Schema.isInt())), "costRate": Schema.optionalKey(RateDtoV1), "duration": Schema.optionalKey(Schema.String.annotate({ "description": "Represents a task duration." })), "estimate": Schema.optionalKey(Schema.String.annotate({ "description": "Represents a task duration estimate." })), "hourlyRate": Schema.optionalKey(RateDtoV1), "id": Schema.optionalKey(Schema.String.annotate({ "description": "Represents task identifier across the system." })), "name": Schema.optionalKey(Schema.String.annotate({ "description": "Represents task name." })), "projectId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents project identifier across the system." })), "status": Schema.optionalKey(TaskStatus), "userGroupIds": Schema.optionalKey(Schema.Array(Schema.String.annotate({ "description": "Represents list of user group ids for the task." })).annotate({ "description": "Represents list of user group ids for the task." }).check(Schema.isUnique())) })
export type UpdateInvoiceRequestV1 = { readonly "clientId"?: string, readonly "companyId"?: string, readonly "currency": string, readonly "discountPercent": number, readonly "dueDate": string, readonly "issuedDate": string, readonly "note"?: string, readonly "number": string, readonly "subject"?: string, readonly "tax2Percent": number, readonly "taxPercent": number, readonly "taxType"?: TaxType, readonly "visibleZeroFields"?: "TAX" | "TAX_2" | "DISCOUNT" }
export const UpdateInvoiceRequestV1 = Schema.Struct({ "clientId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents client identifier across the system." })), "companyId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents company identifier across the system." })), "currency": Schema.String.annotate({ "description": "Represents the currency used by the invoice." }).check(Schema.isMinLength(1)).check(Schema.isMaxLength(100)), "discountPercent": Schema.Number.annotate({ "description": "Represents an invoice discount percent as double.", "format": "double" }).check(Schema.isFinite()), "dueDate": Schema.String.annotate({ "description": "Represents an invoice due date in yyyy-MM-ddThh:mm:ssZ format.", "format": "date-time" }), "issuedDate": Schema.String.annotate({ "description": "Represents an invoice issued date in yyyy-MM-ddThh:mm:ssZ format.", "format": "date-time" }), "note": Schema.optionalKey(Schema.String.annotate({ "description": "Represents an invoice note." })), "number": Schema.String.annotate({ "description": "Represents an invoice number." }).check(Schema.isMinLength(1)), "subject": Schema.optionalKey(Schema.String.annotate({ "description": "Represents an invoice subject." })), "tax2Percent": Schema.Number.annotate({ "description": "Represents an invoice tax 2 percent as double.", "format": "double" }).check(Schema.isFinite()), "taxPercent": Schema.Number.annotate({ "description": "Represents an invoice tax percent as double.", "format": "double" }).check(Schema.isFinite()), "taxType": Schema.optionalKey(TaxType), "visibleZeroFields": Schema.optionalKey(Schema.Literals(["TAX", "TAX_2", "DISCOUNT"]).annotate({ "description": "Represents a list of zero value invoice fields that will be visible." })) })
export type UpdateInvoicedStatusRequest = { readonly "invoiced": boolean, readonly "timeEntryIds": ReadonlyArray<TimeEntryId> }
export const UpdateInvoicedStatusRequest = Schema.Struct({ "invoiced": Schema.Boolean.annotate({ "description": "Indicates whether time entry is invoiced or not." }), "timeEntryIds": Schema.Array(TimeEntryId).annotate({ "description": "Represents a list of invoiced time entry ids" }).check(Schema.isMinLength(1)).check(Schema.isUnique()) })
export type ProjectEstimateRequest = { readonly "budgetEstimate"?: EstimateWithOptionsRequest, readonly "estimateReset"?: EstimateResetRequest, readonly "timeEstimate"?: TimeEstimateRequest }
export const ProjectEstimateRequest = Schema.Struct({ "budgetEstimate": Schema.optionalKey(EstimateWithOptionsRequest), "estimateReset": Schema.optionalKey(EstimateResetRequest), "timeEstimate": Schema.optionalKey(TimeEstimateRequest) })
export type TimeEntryInfoDto = { readonly "approvalRequestId"?: string, readonly "billable"?: boolean, readonly "costRate"?: RateDto, readonly "customFieldValues"?: ReadonlyArray<CustomFieldValueDto>, readonly "description"?: string, readonly "hourlyRate"?: RateDto, readonly "id"?: string, readonly "isLocked"?: boolean, readonly "project"?: ProjectInfoDto, readonly "tags"?: ReadonlyArray<TagDto>, readonly "task"?: TaskInfoDto, readonly "timeInterval"?: TimeIntervalDto, readonly "type"?: "REGULAR" | "BREAK" | "HOLIDAY" | "TIME_OFF" }
export const TimeEntryInfoDto = Schema.Struct({ "approvalRequestId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents approval identifier across the system." })), "billable": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether time entry is billable or not." })), "costRate": Schema.optionalKey(RateDto), "customFieldValues": Schema.optionalKey(Schema.Array(CustomFieldValueDto).annotate({ "description": "Represents a list of custom field value objects." })), "description": Schema.optionalKey(Schema.String.annotate({ "description": "Represents a time entry description." })), "hourlyRate": Schema.optionalKey(RateDto), "id": Schema.optionalKey(Schema.String.annotate({ "description": "Represents time entry identifier across the system." })), "isLocked": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether time entry is locked or not." })), "project": Schema.optionalKey(ProjectInfoDto), "tags": Schema.optionalKey(Schema.Array(TagDto).annotate({ "description": "Represents a list of tag objects." })), "task": Schema.optionalKey(TaskInfoDto), "timeInterval": Schema.optionalKey(TimeIntervalDto), "type": Schema.optionalKey(Schema.Literals(["REGULAR", "BREAK", "HOLIDAY", "TIME_OFF"]).annotate({ "description": "Represents a time entry type enum." })) }).annotate({ "description": "Represents a list of time entry info data transfer objects." })
export type TimeEntryWithCustomFieldsDto = { readonly "billable"?: boolean, readonly "customFieldValues"?: ReadonlyArray<CustomFieldValueDto>, readonly "description"?: string, readonly "id"?: string, readonly "projectId"?: string, readonly "tagIds"?: ReadonlyArray<string>, readonly "taskId"?: string, readonly "timeInterval"?: TimeIntervalDto, readonly "type"?: "REGULAR" | "BREAK" | "HOLIDAY" | "TIME_OFF", readonly "userId"?: string, readonly "workspaceId"?: string }
export const TimeEntryWithCustomFieldsDto = Schema.Struct({ "billable": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether a time entry is billable." })), "customFieldValues": Schema.optionalKey(Schema.Array(CustomFieldValueDto).annotate({ "description": "Represents a list of custom field value objects." })), "description": Schema.optionalKey(Schema.String.annotate({ "description": "Represents a time entry description." })), "id": Schema.optionalKey(Schema.String.annotate({ "description": "Represents a time entry identifier across the system." })), "projectId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents a project identifier across the system." })), "tagIds": Schema.optionalKey(Schema.Array(Schema.String.annotate({ "description": "Represents a list of tag identifiers across the system." })).annotate({ "description": "Represents a list of tag identifiers across the system." })), "taskId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents a task identifier across the system." })), "timeInterval": Schema.optionalKey(TimeIntervalDto), "type": Schema.optionalKey(Schema.Literals(["REGULAR", "BREAK", "HOLIDAY", "TIME_OFF"]).annotate({ "description": "Represents a time entry type enum." })), "userId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents a user identifier across the system." })), "workspaceId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents a workspace identifier across the system." })) }).annotate({ "description": "Represents a set of template time entries." })
export type TimeEntryDtoImplV1 = { readonly "billable": boolean, readonly "customFieldValues"?: ReadonlyArray<CustomFieldValueDtoV1>, readonly "description": string, readonly "id": string, readonly "isLocked"?: boolean, readonly "kioskId"?: string | null, readonly "projectId"?: string | null, readonly "tagIds"?: ReadonlyArray<string> | null, readonly "taskId"?: string | null, readonly "timeInterval": TimeIntervalDtoV1, readonly "type"?: "REGULAR" | "BREAK" | "HOLIDAY" | "TIME_OFF", readonly "userId": string, readonly "workspaceId": string }
export const TimeEntryDtoImplV1 = Schema.Struct({ "billable": Schema.Boolean.annotate({ "description": "Indicates whether a time entry is billable." }), "customFieldValues": Schema.optionalKey(Schema.Array(CustomFieldValueDtoV1).annotate({ "description": "Represents a list of custom field value objects." })), "description": Schema.String.annotate({ "description": "Represents time entry description." }), "id": Schema.String.annotate({ "description": "Represents time entry identifier across the system." }), "isLocked": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Represents whether time entry is locked for modification." })), "kioskId": Schema.optionalKey(Schema.Union([Schema.String, Schema.Null]).annotate({ "description": "Represents kiosk identifier across the system." })), "projectId": Schema.optionalKey(Schema.Union([Schema.String, Schema.Null]).annotate({ "description": "Represents project identifier across the system." })), "tagIds": Schema.optionalKey(Schema.Union([Schema.Array(Schema.String), Schema.Null]).annotate({ "description": "Represents a list of tag identifiers across the system." })), "taskId": Schema.optionalKey(Schema.Union([Schema.String, Schema.Null]).annotate({ "description": "Represents task identifier across the system." })), "timeInterval": TimeIntervalDtoV1, "type": Schema.optionalKey(Schema.Literals(["REGULAR", "BREAK", "HOLIDAY", "TIME_OFF"]).annotate({ "description": "Represents a time entry type enum." })), "userId": Schema.String.annotate({ "description": "Represents user identifier across the system." }), "workspaceId": Schema.String.annotate({ "description": "Represents workspace identifier across the system." }) })
export type TimeEntryDtoV1 = { readonly "billable"?: boolean, readonly "customFieldValues"?: ReadonlyArray<CustomFieldValueDtoV1>, readonly "description"?: string, readonly "id"?: string, readonly "isLocked"?: boolean, readonly "kioskId"?: string | null, readonly "projectId"?: string | null, readonly "tagIds"?: ReadonlyArray<string> | null, readonly "taskId"?: string | null, readonly "timeInterval"?: TimeIntervalDtoV1, readonly "type"?: "REGULAR" | "BREAK" | "HOLIDAY" | "TIME_OFF", readonly "userId"?: string, readonly "workspaceId"?: string }
export const TimeEntryDtoV1 = Schema.Struct({ "billable": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether a time entry is billable." })), "customFieldValues": Schema.optionalKey(Schema.Array(CustomFieldValueDtoV1).annotate({ "description": "Represents a list of custom field value objects." })), "description": Schema.optionalKey(Schema.String.annotate({ "description": "Represents time entry description." })), "id": Schema.optionalKey(Schema.String.annotate({ "description": "Represents time entry identifier across the system." })), "isLocked": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Represents whether time entry is locked for modification." })), "kioskId": Schema.optionalKey(Schema.Union([Schema.String, Schema.Null]).annotate({ "description": "Represents kiosk identifier across the system." })), "projectId": Schema.optionalKey(Schema.Union([Schema.String, Schema.Null]).annotate({ "description": "Represents project identifier across the system." })), "tagIds": Schema.optionalKey(Schema.Union([Schema.Array(Schema.String), Schema.Null]).annotate({ "description": "Represents a list of tag identifiers across the system." })), "taskId": Schema.optionalKey(Schema.Union([Schema.String, Schema.Null]).annotate({ "description": "Represents task identifier across the system." })), "timeInterval": Schema.optionalKey(TimeIntervalDtoV1), "type": Schema.optionalKey(Schema.Literals(["REGULAR", "BREAK", "HOLIDAY", "TIME_OFF"]).annotate({ "description": "Represents a time entry type enum." })), "userId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents user identifier across the system." })), "workspaceId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents workspace identifier across the system." })) })
export type TimeEntryWithRatesDtoV1 = { readonly "billable": boolean, readonly "costRate"?: RateDtoV1, readonly "customFieldValues"?: ReadonlyArray<CustomFieldValueDtoV1>, readonly "description": string, readonly "hourlyRate"?: RateDtoV1, readonly "id": string, readonly "isLocked"?: boolean, readonly "kioskId"?: string | null, readonly "projectId"?: string | null, readonly "tagIds"?: ReadonlyArray<string> | null, readonly "taskId"?: string | null, readonly "timeInterval": TimeIntervalDtoV1, readonly "type"?: "REGULAR" | "BREAK" | "HOLIDAY" | "TIME_OFF", readonly "userId": string, readonly "workspaceId": string }
export const TimeEntryWithRatesDtoV1 = Schema.Struct({ "billable": Schema.Boolean.annotate({ "description": "Indicates whether a time entry is billable." }), "costRate": Schema.optionalKey(RateDtoV1), "customFieldValues": Schema.optionalKey(Schema.Array(CustomFieldValueDtoV1).annotate({ "description": "Represents a list of custom field value objects." })), "description": Schema.String.annotate({ "description": "Represents time entry description." }), "hourlyRate": Schema.optionalKey(RateDtoV1), "id": Schema.String.annotate({ "description": "Represents time entry identifier across the system." }), "isLocked": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Represents whether time entry is locked for modification." })), "kioskId": Schema.optionalKey(Schema.Union([Schema.String, Schema.Null]).annotate({ "description": "Represents kiosk identifier across the system." })), "projectId": Schema.optionalKey(Schema.Union([Schema.String, Schema.Null]).annotate({ "description": "Represents project identifier across the system." })), "tagIds": Schema.optionalKey(Schema.Union([Schema.Array(Schema.String), Schema.Null]).annotate({ "description": "Represents a list of tag identifiers across the system." })), "taskId": Schema.optionalKey(Schema.Union([Schema.String, Schema.Null]).annotate({ "description": "Represents task identifier across the system." })), "timeInterval": TimeIntervalDtoV1, "type": Schema.optionalKey(Schema.Literals(["REGULAR", "BREAK", "HOLIDAY", "TIME_OFF"]).annotate({ "description": "Represents a time entry type enum." })), "userId": Schema.String.annotate({ "description": "Represents user identifier across the system." }), "workspaceId": Schema.String.annotate({ "description": "Represents workspace identifier across the system." }) })
export type InvoiceFilterRequestV1 = { readonly "clients"?: ContainsArchivedFilterRequest, readonly "companies"?: BaseFilterRequest, readonly "exactAmount"?: number, readonly "exactBalance"?: number, readonly "greaterThanAmount"?: number, readonly "greaterThanBalance"?: number, readonly "invoiceNumber"?: string, readonly "issueDate"?: TimeRangeRequestDtoV1, readonly "lessThanAmount"?: number, readonly "lessThanBalance"?: number, readonly "page"?: number, readonly "pageSize"?: number, readonly "sortColumn"?: "ID" | "CLIENT" | "DUE_ON" | "ISSUE_DATE" | "AMOUNT" | "BALANCE", readonly "sortOrder"?: "ASCENDING" | "DESCENDING", readonly "statuses"?: ReadonlyArray<"UNSENT" | "SENT" | "PAID" | "PARTIALLY_PAID" | "VOID" | "OVERDUE">, readonly "strictSearch"?: boolean }
export const InvoiceFilterRequestV1 = Schema.Struct({ "clients": Schema.optionalKey(ContainsArchivedFilterRequest), "companies": Schema.optionalKey(BaseFilterRequest), "exactAmount": Schema.optionalKey(Schema.Number.annotate({ "description": "Represents an invoice amount. If provided, you'll get a filtered list of invoices that has the equal amount as specified.", "format": "int64" }).check(Schema.isInt())), "exactBalance": Schema.optionalKey(Schema.Number.annotate({ "description": "Represents an invoice balance. If provided, you'll get a filtered list of invoices that has the equal balance as specified.", "format": "int64" }).check(Schema.isInt())), "greaterThanAmount": Schema.optionalKey(Schema.Number.annotate({ "description": "Represents an invoice amount. If provided, you'll get a filtered list of invoices that has amount greater than specified.", "format": "int64" }).check(Schema.isInt())), "greaterThanBalance": Schema.optionalKey(Schema.Number.annotate({ "description": "Represents an invoice balance. If provided, you'll get a filtered list of invoices that has balance greater than specified.", "format": "int64" }).check(Schema.isInt())), "invoiceNumber": Schema.optionalKey(Schema.String.annotate({ "description": "If provided, you'll get a filtered list of invoices that contain the provided string in their invoice number." })), "issueDate": Schema.optionalKey(TimeRangeRequestDtoV1), "lessThanAmount": Schema.optionalKey(Schema.Number.annotate({ "description": "Represents an invoice amount. If provided, you'll get a filtered list of invoices that has amount less than specified.", "format": "int64" }).check(Schema.isInt())), "lessThanBalance": Schema.optionalKey(Schema.Number.annotate({ "description": "Represents an invoice balance. If provided, you'll get a filtered list of invoices that has balance less than specified.", "format": "int64" }).check(Schema.isInt())), "page": Schema.optionalKey(Schema.Number.annotate({ "description": "Page number.", "format": "int32" }).check(Schema.isInt())), "pageSize": Schema.optionalKey(Schema.Number.annotate({ "description": "Page size.", "format": "int32" }).check(Schema.isInt())), "sortColumn": Schema.optionalKey(Schema.Literals(["ID", "CLIENT", "DUE_ON", "ISSUE_DATE", "AMOUNT", "BALANCE"]).annotate({ "description": "Represents the column name to be used as sorting criteria." })), "sortOrder": Schema.optionalKey(Schema.Literals(["ASCENDING", "DESCENDING"]).annotate({ "description": "Represents the sorting order." })), "statuses": Schema.optionalKey(Schema.Array(Schema.Literals(["UNSENT", "SENT", "PAID", "PARTIALLY_PAID", "VOID", "OVERDUE"]).annotate({ "description": "Represents a list of invoice statuses. If provided, you'll get a filtered list of invoices that matches any of the invoice status provided." })).annotate({ "description": "Represents a list of invoice statuses. If provided, you'll get a filtered list of invoices that matches any of the invoice status provided." })), "strictSearch": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Flag to toggle on/off strict search mode. When set to true, search by invoice number only will return invoices whose number exactly matches the string value given for the 'invoiceNumber' parameter. When set to false, results will also include invoices whose number contain the string value, but could be longer than the string value itself. For example, if there is an invoice with the number '123456', and the search value is '123', setting strict-name-search to true will not return that invoice in the results, whereas setting it to false will." })) })
export type SchedulingUsersTotalsDtoV1 = { readonly "capacityPerDay"?: number, readonly "totalHoursPerDay"?: ReadonlyArray<TotalsPerDayDto>, readonly "userId"?: string, readonly "userImage"?: string, readonly "userName"?: string, readonly "userStatus"?: string, readonly "workingDays"?: "MONDAY" | "TUESDAY" | "WEDNESDAY" | "THURSDAY" | "FRIDAY" | "SATURDAY" | "SUNDAY", readonly "workspaceId"?: string }
export const SchedulingUsersTotalsDtoV1 = Schema.Struct({ "capacityPerDay": Schema.optionalKey(Schema.Number.annotate({ "description": "Represents capacity per day in seconds. For a 7hr work day, value is 25200.", "format": "double" }).check(Schema.isFinite())), "totalHoursPerDay": Schema.optionalKey(Schema.Array(TotalsPerDayDto).annotate({ "description": "Represents total hours per day object." })), "userId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents user identifier across the system." })), "userImage": Schema.optionalKey(Schema.String.annotate({ "description": "Represents url path to user image." })), "userName": Schema.optionalKey(Schema.String.annotate({ "description": "Represents user name." })), "userStatus": Schema.optionalKey(Schema.String.annotate({ "description": "Represents user status." })), "workingDays": Schema.optionalKey(Schema.Literals(["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"]).annotate({ "description": "Represents list of days of the week." })), "workspaceId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents workspace identifier across the system." })) })
export type CreateTimeEntryRequest = { readonly "billable"?: boolean, readonly "customAttributes"?: ReadonlyArray<CreateCustomAttributeRequest>, readonly "customFields"?: ReadonlyArray<UpdateCustomFieldRequest>, readonly "description": string, readonly "end"?: string, readonly "projectId"?: string, readonly "start": string, readonly "tagIds"?: ReadonlyArray<string>, readonly "taskId"?: string, readonly "type"?: "REGULAR" | "BREAK" }
export const CreateTimeEntryRequest = Schema.Struct({ "billable": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether a time entry is billable or not." })), "customAttributes": Schema.optionalKey(Schema.Array(CreateCustomAttributeRequest).annotate({ "description": "Represents a list of create custom field request objects." }).check(Schema.isMinLength(0)).check(Schema.isMaxLength(10))), "customFields": Schema.optionalKey(Schema.Array(UpdateCustomFieldRequest).annotate({ "description": "Represents a list of value objects for user’s custom fields." }).check(Schema.isMinLength(0)).check(Schema.isMaxLength(50))), "description": Schema.String.annotate({ "description": "Represents time entry description." }).check(Schema.isMaxLength(3000)), "end": Schema.optionalKey(Schema.String.annotate({ "description": "Represents an end date in yyyy-MM-ddThh:mm:ssZ format.", "format": "date-time" })), "projectId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents a project identifier across the system." })), "start": Schema.String.annotate({ "description": "Represents a start date in yyyy-MM-ddThh:mm:ssZ format.", "format": "date-time" }), "tagIds": Schema.optionalKey(Schema.Array(Schema.String.annotate({ "description": "Represents a list of tag ids." })).annotate({ "description": "Represents a list of tag ids." })), "taskId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents a task identifier across the system." })), "type": Schema.optionalKey(Schema.Literals(["REGULAR", "BREAK"]).annotate({ "description": "Valid time entry type." })) })
export type UpdateTimeEntryBulkRequest = { readonly "billable"?: boolean, readonly "customFields"?: ReadonlyArray<UpdateCustomFieldRequest>, readonly "description"?: string, readonly "end"?: string, readonly "id": string, readonly "projectId"?: string, readonly "start"?: string, readonly "tagIds"?: ReadonlyArray<string>, readonly "taskId"?: string, readonly "type"?: "REGULAR" | "BREAK" }
export const UpdateTimeEntryBulkRequest = Schema.Struct({ "billable": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether a time entry is billable or not." })), "customFields": Schema.optionalKey(Schema.Array(UpdateCustomFieldRequest).check(Schema.isMinLength(0)).check(Schema.isMaxLength(50))), "description": Schema.optionalKey(Schema.String.annotate({ "description": "Represents a time entry description." }).check(Schema.isMinLength(0)).check(Schema.isMaxLength(3000))), "end": Schema.optionalKey(Schema.String.annotate({ "description": "Represents an end date in the yyyy-MM-ddThh:mm:ssZ format.", "format": "date-time" })), "id": Schema.String.annotate({ "description": "Represents a time entry identifier across the system." }).check(Schema.isMinLength(1)), "projectId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents a project identifier across the system." })), "start": Schema.optionalKey(Schema.String.annotate({ "description": "Represents a start date in the yyyy-MM-ddThh:mm:ssZ format.", "format": "date-time" })), "tagIds": Schema.optionalKey(Schema.Array(Schema.String.annotate({ "description": "Represents a list of tag ids." })).annotate({ "description": "Represents a list of tag ids." })), "taskId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents a task identifier across the system." })), "type": Schema.optionalKey(Schema.Literals(["REGULAR", "BREAK"])) })
export type UpdateTimeEntryRequest = { readonly "billable"?: boolean, readonly "customFields"?: ReadonlyArray<UpdateCustomFieldRequest>, readonly "description"?: string, readonly "end"?: string, readonly "projectId"?: string, readonly "start": string, readonly "tagIds"?: ReadonlyArray<string>, readonly "taskId"?: string, readonly "type"?: "REGULAR" | "BREAK" }
export const UpdateTimeEntryRequest = Schema.Struct({ "billable": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether a time entry is billable or not." })), "customFields": Schema.optionalKey(Schema.Array(UpdateCustomFieldRequest).annotate({ "description": "Represents a list of value objects for user’s custom fields." }).check(Schema.isMinLength(0)).check(Schema.isMaxLength(50))), "description": Schema.optionalKey(Schema.String.annotate({ "description": "Represents time entry description." }).check(Schema.isMinLength(0)).check(Schema.isMaxLength(3000))), "end": Schema.optionalKey(Schema.String.annotate({ "description": "Represents an end date in yyyy-MM-ddThh:mm:ssZ format.", "format": "date-time" })), "projectId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents a project identifier across the system." })), "start": Schema.String.annotate({ "description": "Represents a start date in yyyy-MM-ddThh:mm:ssZ format.", "format": "date-time" }), "tagIds": Schema.optionalKey(Schema.Array(Schema.String.annotate({ "description": "Represents a list of tag ids." })).annotate({ "description": "Represents a list of tag ids." })), "taskId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents a task identifier across the system." })), "type": Schema.optionalKey(Schema.Literals(["REGULAR", "BREAK"])) })
export type LimitedUserRequest = { readonly "costRate"?: number, readonly "hourlyRate"?: number, readonly "name": string, readonly "userCustomFields"?: ReadonlyArray<UpsertUserCustomFieldRequest>, readonly "userGroups"?: ReadonlyArray<string>, readonly "weekStart"?: "MONDAY" | "TUESDAY" | "WEDNESDAY" | "THURSDAY" | "FRIDAY" | "SATURDAY" | "SUNDAY", readonly "workCapacity"?: string, readonly "workingDays"?: "MONDAY" | "TUESDAY" | "WEDNESDAY" | "THURSDAY" | "FRIDAY" | "SATURDAY" | "SUNDAY" }
export const LimitedUserRequest = Schema.Struct({ "costRate": Schema.optionalKey(Schema.Number.annotate({ "description": "Represents cost rate of user. Example: 12300 for 123", "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0))), "hourlyRate": Schema.optionalKey(Schema.Number.annotate({ "description": "Represents hourly rate of user. Example: 12300 for 123", "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0))), "name": Schema.String.annotate({ "description": "Represents name of the user." }).check(Schema.isMinLength(1)), "userCustomFields": Schema.optionalKey(Schema.Array(UpsertUserCustomFieldRequest).annotate({ "description": "Represents a list of upsert user custom field request." })), "userGroups": Schema.optionalKey(Schema.Array(Schema.String.annotate({ "description": "Represents the user group names of the user" }).check(Schema.isMinLength(1))).annotate({ "description": "Represents the user group names of the user" }).check(Schema.isUnique())), "weekStart": Schema.optionalKey(Schema.Literals(["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"]).annotate({ "description": "Represents a day of the week." })), "workCapacity": Schema.optionalKey(Schema.String.annotate({ "description": "Represents work capacity as a time duration in the ISO-8601 format." })), "workingDays": Schema.optionalKey(Schema.Literals(["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"]).annotate({ "description": "Represents a list of days of the week." })) })
export type MemberProfileFullRequestV1 = { readonly "imageUrl"?: string, readonly "name"?: string, readonly "removeProfileImage"?: boolean, readonly "userCustomFields"?: ReadonlyArray<UpsertUserCustomFieldRequest>, readonly "weekStart"?: "MONDAY" | "TUESDAY" | "WEDNESDAY" | "THURSDAY" | "FRIDAY" | "SATURDAY" | "SUNDAY", readonly "workCapacity"?: string, readonly "workingDays"?: "MONDAY" | "TUESDAY" | "WEDNESDAY" | "THURSDAY" | "FRIDAY" | "SATURDAY" | "SUNDAY" }
export const MemberProfileFullRequestV1 = Schema.Struct({ "imageUrl": Schema.optionalKey(Schema.String.annotate({ "description": "Represents an image url. A field that can only be updated for limited users." })), "name": Schema.optionalKey(Schema.String.annotate({ "description": "This body field is deprecated and can only be updated for limited users. Represents name of the user and can be changed on the CAKE.com Account profile page." }).check(Schema.isMinLength(1)).check(Schema.isMaxLength(100))), "removeProfileImage": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether to remove profile image or not. A field that can only be updated for limited users." })), "userCustomFields": Schema.optionalKey(Schema.Array(UpsertUserCustomFieldRequest).annotate({ "description": "Represents a list of upsert user custom field objects." })), "weekStart": Schema.optionalKey(Schema.Literals(["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"]).annotate({ "description": "Represents a day of the week." })), "workCapacity": Schema.optionalKey(Schema.String.annotate({ "description": "Represents work capacity as a time duration in the ISO-8601 format. For example, for a 7hr work day, input should be PT7H." })), "workingDays": Schema.optionalKey(Schema.Literals(["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"]).annotate({ "description": "Represents a list of days of the week." })) })
export type AddUsersToProjectRequestV1 = { readonly "remove"?: boolean, readonly "userGroups"?: UserGroupIdsSchema, readonly "userIds"?: ReadonlyArray<string> }
export const AddUsersToProjectRequestV1 = Schema.Struct({ "remove": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Setting this flag to 'true' will remove the given users from the project." })), "userGroups": Schema.optionalKey(UserGroupIdsSchema), "userIds": Schema.optionalKey(Schema.Array(Schema.String.annotate({ "description": "Represents array of user ids which should be added/removed." })).annotate({ "description": "Represents array of user ids which should be added/removed." })) })
export type UserGroupDtoV1 = { readonly "id"?: string, readonly "name"?: string, readonly "teamManagers"?: ReadonlyArray<UserRedactedDtoV1>, readonly "userIds"?: ReadonlyArray<string>, readonly "workspaceId"?: string }
export const UserGroupDtoV1 = Schema.Struct({ "id": Schema.optionalKey(Schema.String.annotate({ "description": "Represents a user group identifier across the system." })), "name": Schema.optionalKey(Schema.String.annotate({ "description": "Represents a user group name." })), "teamManagers": Schema.optionalKey(Schema.Array(UserRedactedDtoV1).annotate({ "description": "Represents a list of assigned team managers for this user group." })), "userIds": Schema.optionalKey(Schema.Array(Schema.String.annotate({ "description": "Represents a list of users' identifiers across the system." })).annotate({ "description": "Represents a list of users' identifiers across the system." })), "workspaceId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents a workspace identifier across the system." })) })
export type InvoiceInfoV1 = { readonly "amount"?: number, readonly "balance"?: number, readonly "billFrom"?: string, readonly "clientId"?: string, readonly "clientName"?: string, readonly "currency"?: string, readonly "daysOverdue"?: number, readonly "dueDate"?: string, readonly "id"?: string, readonly "issuedDate"?: string, readonly "number"?: string, readonly "paid"?: number, readonly "status"?: "UNSENT" | "SENT" | "PAID" | "PARTIALLY_PAID" | "VOID" | "OVERDUE", readonly "visibleZeroFields"?: VisibleZeroFieldsInvoice }
export const InvoiceInfoV1 = Schema.Struct({ "amount": Schema.optionalKey(Schema.Number.annotate({ "description": "Represents an invoice amount as long.", "format": "int64" }).check(Schema.isInt())), "balance": Schema.optionalKey(Schema.Number.annotate({ "description": "Represents an invoice balance amount as long.", "format": "int64" }).check(Schema.isInt())), "billFrom": Schema.optionalKey(Schema.String.annotate({ "description": "Represents to whom an invoice is billed from." })), "clientId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents client identifier across the system." })), "clientName": Schema.optionalKey(Schema.String.annotate({ "description": "Represents client name for an invoice." })), "currency": Schema.optionalKey(Schema.String.annotate({ "description": "Represents the currency used by the invoice." })), "daysOverdue": Schema.optionalKey(Schema.Number.annotate({ "description": "Represents the number of days an invoice is overdue.", "format": "int64" }).check(Schema.isInt())), "dueDate": Schema.optionalKey(Schema.String.annotate({ "description": "Represents an invoice due date in yyyy-MM-ddThh:mm:ssZ format.", "format": "date-time" })), "id": Schema.optionalKey(Schema.String.annotate({ "description": "Represents invoice identifier across the system." })), "issuedDate": Schema.optionalKey(Schema.String.annotate({ "description": "Represents an invoice issued date in yyyy-MM-ddThh:mm:ssZ format.", "format": "date-time" })), "number": Schema.optionalKey(Schema.String.annotate({ "description": "Represents an invoice number." })), "paid": Schema.optionalKey(Schema.Number.annotate({ "description": "Represents an invoice paid amount as long.", "format": "int64" }).check(Schema.isInt())), "status": Schema.optionalKey(Schema.Literals(["UNSENT", "SENT", "PAID", "PARTIALLY_PAID", "VOID", "OVERDUE"]).annotate({ "description": "Represents the status of an invoice." })), "visibleZeroFields": Schema.optionalKey(VisibleZeroFieldsInvoice) }).annotate({ "description": "Represents a list of invoice info." })
export type WebhookDtoV1 = { readonly "authToken"?: string, readonly "deliveryEnabled"?: boolean, readonly "enabled"?: boolean, readonly "id"?: string, readonly "name"?: string, readonly "planEnabled"?: boolean, readonly "triggerSource"?: ReadonlyArray<string>, readonly "triggerSourceType"?: WebhookEventTriggerSourceType, readonly "url"?: string, readonly "userId"?: string, readonly "webhookEvent"?: WebhookEventType, readonly "workspaceId"?: string }
export const WebhookDtoV1 = Schema.Struct({ "authToken": Schema.optionalKey(Schema.String.annotate({ "description": "Represents an authentication token." })), "deliveryEnabled": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether webhook delivery is enabled or not. It can be disabled if delivery failed for too many times." })), "enabled": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether webhook is enabled or not." })), "id": Schema.optionalKey(Schema.String.annotate({ "description": "Represents webhook identifier across the system." })), "name": Schema.optionalKey(Schema.String.annotate({ "description": "Represents webhook name." })), "planEnabled": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether webhook is supported by current plan. It can be disabled if number of webhooks exceeds plan limit or if the feature is not supported on current plan." })), "triggerSource": Schema.optionalKey(Schema.Array(Schema.String.annotate({ "description": "Represents a list of trigger sources." })).annotate({ "description": "Represents a list of trigger sources." })), "triggerSourceType": Schema.optionalKey(WebhookEventTriggerSourceType), "url": Schema.optionalKey(Schema.String.annotate({ "description": "Represents workspace identifier across the system." })), "userId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents user identifier across the system." })), "webhookEvent": Schema.optionalKey(WebhookEventType), "workspaceId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents workspace identifier across the system." })) })
export type TimeEntryReportTotals = { readonly "amounts"?: ReadonlyArray<AmountDto>, readonly "entriesCount"?: number, readonly "id"?: string, readonly "totalBillableTime"?: number, readonly "totalTime"?: number }
export const TimeEntryReportTotals = Schema.Struct({ "amounts": Schema.optionalKey(Schema.Array(AmountDto).annotate({ "description": "List of amounts" })), "entriesCount": Schema.optionalKey(Schema.Number.annotate({ "description": "Represents entries count", "format": "int32" }).check(Schema.isInt())), "id": Schema.optionalKey(Schema.String.annotate({ "description": "Represents time entry report identifier across the system." })), "totalBillableTime": Schema.optionalKey(Schema.Number.annotate({ "description": "Represents total billable time" }).check(Schema.isFinite())), "totalTime": Schema.optionalKey(Schema.Number.annotate({ "description": "Represents total time" }).check(Schema.isFinite())) }).annotate({ "description": "List of totals" })
export type AttendanceFilterV1 = { readonly "balanceFilters"?: ReadonlyArray<CompareBalanceFilter>, readonly "breakFilters"?: ReadonlyArray<CompareBreakFilter>, readonly "capacityFilters"?: ReadonlyArray<CompareCapacityFilter>, readonly "endFilters"?: ReadonlyArray<CompareEndFilter>, readonly "groups"?: ReadonlyArray<string>, readonly "hasTimeOff"?: boolean, readonly "overtimeFilters"?: ReadonlyArray<CompareOvertimeFilter>, readonly "page"?: number, readonly "pageSize"?: number, readonly "sortColumn"?: "GROUP" | "USER" | "DATE" | "START" | "END" | "BREAK" | "WORK" | "CAPACITY" | "OVERTIME" | "UNDERTIME" | "BALANCE" | "TIME_OFF", readonly "startFilters"?: ReadonlyArray<CompareStartFilter>, readonly "undertimeFilters"?: ReadonlyArray<CompareUndertimeFilter>, readonly "workFilters"?: ReadonlyArray<CompareWorkFilter> }
export const AttendanceFilterV1 = Schema.Struct({ "balanceFilters": Schema.optionalKey(Schema.Array(CompareBalanceFilter)), "breakFilters": Schema.optionalKey(Schema.Array(CompareBreakFilter)), "capacityFilters": Schema.optionalKey(Schema.Array(CompareCapacityFilter)), "endFilters": Schema.optionalKey(Schema.Array(CompareEndFilter)), "groups": Schema.optionalKey(Schema.Array(Schema.String).annotate({ "writeOnly": true })), "hasTimeOff": Schema.optionalKey(Schema.Boolean.annotate({ "description": "If set to true, report will include time off hours." })), "overtimeFilters": Schema.optionalKey(Schema.Array(CompareOvertimeFilter)), "page": Schema.optionalKey(Schema.Number.annotate({ "description": "Specifies page number.", "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1))), "pageSize": Schema.optionalKey(Schema.Number.annotate({ "description": "Specifies page size.", "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1))), "sortColumn": Schema.optionalKey(Schema.Literals(["GROUP", "USER", "DATE", "START", "END", "BREAK", "WORK", "CAPACITY", "OVERTIME", "UNDERTIME", "BALANCE", "TIME_OFF"])), "startFilters": Schema.optionalKey(Schema.Array(CompareStartFilter)), "undertimeFilters": Schema.optionalKey(Schema.Array(CompareUndertimeFilter)), "workFilters": Schema.optionalKey(Schema.Array(CompareWorkFilter)) }).annotate({ "description": "Represents an attendance report filter." })
export type ExpenseReportFilterV1 = { readonly "approvalState"?: "APPROVED" | "UNAPPROVED" | "ALL", readonly "billable"?: boolean, readonly "categories"?: ContainsArchivedFilterV1, readonly "clients"?: ContainsArchivedFilterV1, readonly "currency"?: ContainsArchivedFilterV1, readonly "dateRangeEnd": string, readonly "dateRangeStart": string, readonly "dateRangeType"?: "ABSOLUTE" | "TODAY" | "YESTERDAY" | "THIS_WEEK" | "LAST_WEEK" | "PAST_TWO_WEEKS" | "THIS_MONTH" | "LAST_MONTH" | "THIS_YEAR" | "LAST_YEAR", readonly "exportType"?: "JSON" | "JSON_V1" | "PDF" | "CSV" | "XLSX" | "ZIP", readonly "invoicingState"?: "INVOICED" | "UNINVOICED" | "ALL", readonly "note"?: string, readonly "page"?: number, readonly "pageSize"?: number, readonly "projects"?: ContainsArchivedFilterV1, readonly "sortColumn"?: "ID" | "PROJECT" | "USER" | "CATEGORY" | "DATE" | "AMOUNT", readonly "sortOrder"?: "ASCENDING" | "DESCENDING", readonly "tasks"?: ContainsTaskFilterV1, readonly "timeZone"?: string, readonly "userGroups"?: ContainsUsersFilterV1, readonly "userLocale"?: string, readonly "users"?: ContainsUsersFilterV1, readonly "weekStart"?: "MONDAY" | "TUESDAY" | "WEDNESDAY" | "THURSDAY" | "FRIDAY" | "SATURDAY" | "SUNDAY", readonly "withoutNote"?: boolean, readonly "zoomLevel"?: "WEEK" | "MONTH" | "YEAR" }
export const ExpenseReportFilterV1 = Schema.Struct({ "approvalState": Schema.optionalKey(Schema.Literals(["APPROVED", "UNAPPROVED", "ALL"]).annotate({ "description": "Represents an approval state" })), "billable": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether report is billable" })), "categories": Schema.optionalKey(ContainsArchivedFilterV1), "clients": Schema.optionalKey(ContainsArchivedFilterV1), "currency": Schema.optionalKey(ContainsArchivedFilterV1), "dateRangeEnd": Schema.String.annotate({ "description": "Provide date in format YYYY-MM-DDTHH:MM:SS.ssssss. The system interprets this value based on the user's timezone (provided in the timeZone request parameter or the timezone configured in the user profile)" }).check(Schema.isMinLength(1)), "dateRangeStart": Schema.String.annotate({ "description": "Provide date in format YYYY-MM-DDTHH:MM:SS.ssssss. The system interprets this value based on the user's timezone (provided in the timeZone request parameter or the timezone configured in the user profile)" }).check(Schema.isMinLength(1)), "dateRangeType": Schema.optionalKey(Schema.Literals(["ABSOLUTE", "TODAY", "YESTERDAY", "THIS_WEEK", "LAST_WEEK", "PAST_TWO_WEEKS", "THIS_MONTH", "LAST_MONTH", "THIS_YEAR", "LAST_YEAR"]).annotate({ "description": "Represents date range type of expense report" })), "exportType": Schema.optionalKey(Schema.Literals(["JSON", "JSON_V1", "PDF", "CSV", "XLSX", "ZIP"]).annotate({ "description": "Represents an export type" })), "invoicingState": Schema.optionalKey(Schema.Literals(["INVOICED", "UNINVOICED", "ALL"]).annotate({ "description": "Represents an invoicing state" })), "note": Schema.optionalKey(Schema.String.annotate({ "description": "Represents a search term for filtering report entries by note" })), "page": Schema.optionalKey(Schema.Number.annotate({ "description": "Page number.", "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1))), "pageSize": Schema.optionalKey(Schema.Number.annotate({ "description": "Page size.", "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1))), "projects": Schema.optionalKey(ContainsArchivedFilterV1), "sortColumn": Schema.optionalKey(Schema.Literals(["ID", "PROJECT", "USER", "CATEGORY", "DATE", "AMOUNT"]).annotate({ "description": "Represents expenses sort column" })), "sortOrder": Schema.optionalKey(Schema.Literals(["ASCENDING", "DESCENDING"]).annotate({ "description": "Represents a sort order" })), "tasks": Schema.optionalKey(ContainsTaskFilterV1), "timeZone": Schema.optionalKey(Schema.String.annotate({ "description": "Represents a time zone" })), "userGroups": Schema.optionalKey(ContainsUsersFilterV1), "userLocale": Schema.optionalKey(Schema.String.annotate({ "description": "Represents a user locale" })), "users": Schema.optionalKey(ContainsUsersFilterV1), "weekStart": Schema.optionalKey(Schema.Literals(["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"]).annotate({ "description": "Represents week start" })), "withoutNote": Schema.optionalKey(Schema.Boolean.annotate({ "description": "If set to 'true', report will only include entries with empty note" })), "zoomLevel": Schema.optionalKey(Schema.Literals(["WEEK", "MONTH", "YEAR"]).annotate({ "description": "Represents a zoom level" })) })
export type DetailedFilterV1 = { readonly "auditFilter"?: AuditFilterV1, readonly "options"?: DetailedOptionsV1, readonly "page"?: number, readonly "pageSize"?: number, readonly "sortColumn"?: "ID" | "DESCRIPTION" | "USER" | "DURATION" | "DATE" | "ZONED_DATE" | "NATURAL" | "USER_DATE" }
export const DetailedFilterV1 = Schema.Struct({ "auditFilter": Schema.optionalKey(AuditFilterV1), "options": Schema.optionalKey(DetailedOptionsV1), "page": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt())), "pageSize": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt())), "sortColumn": Schema.optionalKey(Schema.Literals(["ID", "DESCRIPTION", "USER", "DURATION", "DATE", "ZONED_DATE", "NATURAL", "USER_DATE"]).annotate({ "description": "If provided, you'll get sorted result by sort column." })) }).annotate({ "description": "Represents a detailed report filter." })
export type SharedReportDtoV1 = { readonly "fixedDate"?: boolean, readonly "id"?: string, readonly "isPublic"?: boolean, readonly "link"?: string, readonly "name"?: string, readonly "reportAuthor"?: string, readonly "type"?: "DETAILED" | "WEEKLY" | "SUMMARY" | "SCHEDULED" | "EXPENSE_DETAILED" | "EXPENSE_RECEIPT" | "PTO_REQUESTS" | "PTO_BALANCE" | "ATTENDANCE" | "INVOICE_EXPENSE" | "INVOICE_TIME" | "PROJECT" | "TEAM_FULL" | "TEAM_LIMITED" | "TEAM_GROUPS" | "INVOICES" | "KIOSK_PIN_LIST" | "KIOSK_ASSIGNEES" | "USER_DATA_EXPORT", readonly "visibleToUserGroups"?: ReadonlyArray<EntityName>, readonly "visibleToUsers"?: ReadonlyArray<EntityName> }
export const SharedReportDtoV1 = Schema.Struct({ "fixedDate": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether the shared report has a fixed date range" })), "id": Schema.optionalKey(Schema.String.annotate({ "description": "Represents a shared report identifier across the system." })), "isPublic": Schema.optionalKey(Schema.Boolean), "link": Schema.optionalKey(Schema.String.annotate({ "description": "Represents URI link of shared report.", "format": "uri" })), "name": Schema.optionalKey(Schema.String.annotate({ "description": "Represents shared report's name." })), "reportAuthor": Schema.optionalKey(Schema.String.annotate({ "description": "Represents report author (user) identifier across the system." })), "type": Schema.optionalKey(Schema.Literals(["DETAILED", "WEEKLY", "SUMMARY", "SCHEDULED", "EXPENSE_DETAILED", "EXPENSE_RECEIPT", "PTO_REQUESTS", "PTO_BALANCE", "ATTENDANCE", "INVOICE_EXPENSE", "INVOICE_TIME", "PROJECT", "TEAM_FULL", "TEAM_LIMITED", "TEAM_GROUPS", "INVOICES", "KIOSK_PIN_LIST", "KIOSK_ASSIGNEES", "USER_DATA_EXPORT"]).annotate({ "description": "Represents shared report type" })), "visibleToUserGroups": Schema.optionalKey(Schema.Array(EntityName)), "visibleToUsers": Schema.optionalKey(Schema.Array(EntityName).annotate({ "description": "Represents ids of user to whom are visible shared report." })) }).annotate({ "description": "Represents the array of reports." })
export type TimeEntryDto = { readonly "approvalRequestId"?: string, readonly "billable": boolean, readonly "clientId"?: string, readonly "clientName"?: string, readonly "description": string, readonly "locked"?: boolean, readonly "projectColor"?: string, readonly "projectId"?: string, readonly "projectName"?: string, readonly "tags"?: ReadonlyArray<ReportTagDto>, readonly "taskId"?: string, readonly "taskName"?: string, readonly "timeInterval": ReportTimeIntervalDto, readonly "userEmail"?: string, readonly "userId": string, readonly "userName"?: string, readonly "id": string, readonly "workspaceId": string, readonly "type"?: string, readonly "isLocked"?: boolean, readonly "tagIds"?: ReadonlyArray<string> }
export const TimeEntryDto = Schema.Struct({ "approvalRequestId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents approval request identifier across the system." })), "billable": Schema.Boolean.annotate({ "description": "Indicates whether the time entry is billable" }), "clientId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents client identifier across the system." })), "clientName": Schema.optionalKey(Schema.String.annotate({ "description": "Represents client name" })), "description": Schema.String.annotate({ "description": "Represents time entry description" }), "locked": Schema.optionalKey(Schema.Boolean), "projectColor": Schema.optionalKey(Schema.String.annotate({ "description": "Represents project color" })), "projectId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents project identifier across the system." })), "projectName": Schema.optionalKey(Schema.String.annotate({ "description": "Represents project name." })), "tags": Schema.optionalKey(Schema.Array(ReportTagDto).annotate({ "description": "List of tags" })), "taskId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents task identifier across the system." })), "taskName": Schema.optionalKey(Schema.String.annotate({ "description": "Represents task name." })), "timeInterval": ReportTimeIntervalDto, "userEmail": Schema.optionalKey(Schema.String.annotate({ "description": "Represents user email." })), "userId": Schema.String.annotate({ "description": "Represents user identifier across the system." }), "userName": Schema.optionalKey(Schema.String.annotate({ "description": "Represents user's name" })), "id": Schema.String.annotate({ "description": "Represents time entry identifier across the system." }), "workspaceId": Schema.String, "type": Schema.optionalKey(Schema.String), "isLocked": Schema.optionalKey(Schema.Boolean), "tagIds": Schema.optionalKey(Schema.Array(Schema.String)) }).annotate({ "description": "time entry" })
export type ExpenseReportDtoV1 = { readonly "amount"?: number, readonly "approvalRequestId"?: string, readonly "billable"?: boolean, readonly "categoryHasUnitPrice"?: boolean, readonly "categoryId"?: string, readonly "categoryName"?: string, readonly "categoryUnit"?: string, readonly "date"?: string, readonly "exportFields"?: ReadonlyArray<"PROJECT" | "CLIENT" | "TASK" | "DESCRIPTION" | "USER" | "TAGS" | "START_DATE" | "START_TIME" | "END_TIME" | "DURATION" | "BILLABLE_AMOUNT" | "COST_AMOUNT" | "PROFIT" | "EMAIL" | "BILLABLE" | "BILLABLE_H" | "NON_BILLABLE_H" | "END_DATE" | "DECIMAL_DURATION" | "BILLABLE_RATE" | "COST_RATE" | "APPROVAL" | "APPROVAL_SUBMISSION_DATE" | "APPROVAL_SUBMISSION_TIME" | "APPROVAL_DATE" | "APPROVAL_TIME" | "BAR_CHART" | "PIE_CHART_1" | "PIE_CHART_2" | "PIE_CHART_3" | "RTL" | "TOTAL" | "SUBGROUP" | "GROUP" | "DATE" | "TIME" | "CATEGORY" | "NOTE" | "AMOUNT" | "INVOICED" | "INVOICE_ID" | "CATEGORY_NO_OF_UNITS" | "CATEGORY_UNIT" | "KIOSK" | "KIOSK_QR_CODE" | "TYPE" | "BREAK" | "NOTES" | "BILLABLE_TOTAL" | "RECEIPTS" | "EXPENSE_TOTAL" | "DATE_OF_CREATION" | "DATE_OF_APPROVAL" | "NAME" | "ROLE" | "PROJECTS" | "STATUS" | "WEEK_START" | "WORKING_DAYS" | "TEAM_MANAGERS" | "TEAM_MEMBERS" | "DAILY_WORK_CAPACITY" | "VISIBILITY" | "BILLABILITY" | "TASKS" | "TRACKED_H" | "ESTIMATED_H" | "REMAINING_H" | "OVERAGE_H" | "TRACKED_BUDGET" | "ESTIMATED_BUDGET" | "REMAINING_BUDGET" | "OVERAGE_BUDGET" | "PROGRESS" | "RECURRING_ESTIMATE" | "EXPENSES" | "BILLABLE_EXPENSES" | "NON_BILLABLE_EXPENSES" | "ADDITIONAL_FIELDS" | "PROJECT_MEMBERS" | "PROJECT_MANAGER" | "APPROVED_BY" | "ISSUE_DATE" | "DUE_ON" | "BALANCE">, readonly "fileId"?: string, readonly "fileName"?: string, readonly "id"?: string, readonly "invoicingInfo"?: InvoicingInfo, readonly "locked"?: boolean, readonly "notes"?: string, readonly "projectColor"?: string, readonly "projectId"?: string, readonly "projectName"?: string, readonly "quantity"?: number, readonly "reportName"?: string, readonly "time"?: string, readonly "userEmail"?: string, readonly "userId"?: string, readonly "userName"?: string, readonly "userStatus"?: string, readonly "workspaceId"?: string }
export const ExpenseReportDtoV1 = Schema.Struct({ "amount": Schema.optionalKey(Schema.Number.annotate({ "description": "Represents expenses amount.", "format": "double" }).check(Schema.isFinite())), "approvalRequestId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents approval request identifier across the system." })), "billable": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether the expenses is billable." })), "categoryHasUnitPrice": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether category has unit price." })), "categoryId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents category identifier across the system." })), "categoryName": Schema.optionalKey(Schema.String.annotate({ "description": "Represents category's name." })), "categoryUnit": Schema.optionalKey(Schema.String.annotate({ "description": "Represents category's unit." })), "date": Schema.optionalKey(Schema.String.annotate({ "description": "Represents expenses date in YYYY-MM-DDTHH:MM:SS.ssssssZ format." })), "exportFields": Schema.optionalKey(Schema.Array(Schema.Literals(["PROJECT", "CLIENT", "TASK", "DESCRIPTION", "USER", "TAGS", "START_DATE", "START_TIME", "END_TIME", "DURATION", "BILLABLE_AMOUNT", "COST_AMOUNT", "PROFIT", "EMAIL", "BILLABLE", "BILLABLE_H", "NON_BILLABLE_H", "END_DATE", "DECIMAL_DURATION", "BILLABLE_RATE", "COST_RATE", "APPROVAL", "APPROVAL_SUBMISSION_DATE", "APPROVAL_SUBMISSION_TIME", "APPROVAL_DATE", "APPROVAL_TIME", "BAR_CHART", "PIE_CHART_1", "PIE_CHART_2", "PIE_CHART_3", "RTL", "TOTAL", "SUBGROUP", "GROUP", "DATE", "TIME", "CATEGORY", "NOTE", "AMOUNT", "INVOICED", "INVOICE_ID", "CATEGORY_NO_OF_UNITS", "CATEGORY_UNIT", "KIOSK", "KIOSK_QR_CODE", "TYPE", "BREAK", "NOTES", "BILLABLE_TOTAL", "RECEIPTS", "EXPENSE_TOTAL", "DATE_OF_CREATION", "DATE_OF_APPROVAL", "NAME", "ROLE", "PROJECTS", "STATUS", "WEEK_START", "WORKING_DAYS", "TEAM_MANAGERS", "TEAM_MEMBERS", "DAILY_WORK_CAPACITY", "VISIBILITY", "BILLABILITY", "TASKS", "TRACKED_H", "ESTIMATED_H", "REMAINING_H", "OVERAGE_H", "TRACKED_BUDGET", "ESTIMATED_BUDGET", "REMAINING_BUDGET", "OVERAGE_BUDGET", "PROGRESS", "RECURRING_ESTIMATE", "EXPENSES", "BILLABLE_EXPENSES", "NON_BILLABLE_EXPENSES", "ADDITIONAL_FIELDS", "PROJECT_MEMBERS", "PROJECT_MANAGER", "APPROVED_BY", "ISSUE_DATE", "DUE_ON", "BALANCE"]).annotate({ "description": "Represents export fields." })).annotate({ "description": "Represents export fields." })), "fileId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents file identifier across the system." })), "fileName": Schema.optionalKey(Schema.String.annotate({ "description": "Represents expenses file name." })), "id": Schema.optionalKey(Schema.String.annotate({ "description": "Represents expenses identifier across the system." })), "invoicingInfo": Schema.optionalKey(InvoicingInfo), "locked": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether the expenses is locked." })), "notes": Schema.optionalKey(Schema.String.annotate({ "description": "Represents expenses note." })), "projectColor": Schema.optionalKey(Schema.String.annotate({ "description": "Represents project's color" })), "projectId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents project identifier across the system." })), "projectName": Schema.optionalKey(Schema.String.annotate({ "description": "Represents project's name." })), "quantity": Schema.optionalKey(Schema.Number.annotate({ "description": "Represents expenses quantity", "format": "double" }).check(Schema.isFinite())), "reportName": Schema.optionalKey(Schema.String.annotate({ "description": "Represents expense name." })), "time": Schema.optionalKey(Schema.String.annotate({ "description": "Represents expense time." })), "userEmail": Schema.optionalKey(Schema.String.annotate({ "description": "Represents user's email." })), "userId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents user identifier across the system." })), "userName": Schema.optionalKey(Schema.String.annotate({ "description": "Represents user's name." })), "userStatus": Schema.optionalKey(Schema.String.annotate({ "description": "Represents user's status." })), "workspaceId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents workspace identifier across the system." })) }).annotate({ "description": "Represents list of expenses" })
export type PageableV1ListAuditLogDtoV1 = { readonly "response"?: ReadonlyArray<AuditLogDtoV1> }
export const PageableV1ListAuditLogDtoV1 = Schema.Struct({ "response": Schema.optionalKey(Schema.Array(AuditLogDtoV1)) })
export type AuditLogGetRequestV1 = { readonly "actions": ReadonlyArray<"CREATE_TIME_PERSONAL_TIMER" | "CREATE_TIME_PERSONAL_MANUAL" | "CREATE_TIME_IMPORT" | "CREATE_TIME_KIOSK" | "CREATE_TIME_FOR_OTHER" | "RESTORE_TIME" | "RESTORE_TIME_FOR_OTHER" | "UPDATE_TIME_PERSONAL" | "UPDATE_TIME_FOR_OTHER" | "DELETE_TIME_PERSONAL" | "DELETE_TIME_FOR_OTHER" | "CREATE_PROJECT" | "CREATE_PROJECT_IMPORT" | "CREATE_PROJECT_QUICKBOOKS" | "UPDATE_PROJECT" | "DELETE_PROJECT" | "CREATE_TASK" | "CREATE_TASK_IMPORT" | "UPDATE_TASK" | "DELETE_TASK" | "CREATE_CLIENT" | "CREATE_CLIENT_IMPORT" | "CREATE_CLIENT_QUICKBOOKS" | "UPDATE_CLIENT" | "DELETE_CLIENT" | "CREATE_TAG" | "CREATE_TAG_IMPORT" | "UPDATE_TAG" | "DELETE_TAG" | "CREATE_EXPENSE" | "CREATE_EXPENSE_FOR_OTHER" | "RESTORE_EXPENSE" | "RESTORE_EXPENSE_FOR_OTHER" | "UPDATE_EXPENSE" | "UPDATE_EXPENSE_FOR_OTHER" | "DELETE_EXPENSE" | "DELETE_EXPENSE_FOR_OTHER">, readonly "authors": Authors, readonly "end": string, readonly "page"?: number, readonly "page-size"?: number, readonly "start": string }
export const AuditLogGetRequestV1 = Schema.Struct({ "actions": Schema.Array(Schema.Literals(["CREATE_TIME_PERSONAL_TIMER", "CREATE_TIME_PERSONAL_MANUAL", "CREATE_TIME_IMPORT", "CREATE_TIME_KIOSK", "CREATE_TIME_FOR_OTHER", "RESTORE_TIME", "RESTORE_TIME_FOR_OTHER", "UPDATE_TIME_PERSONAL", "UPDATE_TIME_FOR_OTHER", "DELETE_TIME_PERSONAL", "DELETE_TIME_FOR_OTHER", "CREATE_PROJECT", "CREATE_PROJECT_IMPORT", "CREATE_PROJECT_QUICKBOOKS", "UPDATE_PROJECT", "DELETE_PROJECT", "CREATE_TASK", "CREATE_TASK_IMPORT", "UPDATE_TASK", "DELETE_TASK", "CREATE_CLIENT", "CREATE_CLIENT_IMPORT", "CREATE_CLIENT_QUICKBOOKS", "UPDATE_CLIENT", "DELETE_CLIENT", "CREATE_TAG", "CREATE_TAG_IMPORT", "UPDATE_TAG", "DELETE_TAG", "CREATE_EXPENSE", "CREATE_EXPENSE_FOR_OTHER", "RESTORE_EXPENSE", "RESTORE_EXPENSE_FOR_OTHER", "UPDATE_EXPENSE", "UPDATE_EXPENSE_FOR_OTHER", "DELETE_EXPENSE", "DELETE_EXPENSE_FOR_OTHER"]).annotate({ "description": "Represents a set of audit log actions." })).annotate({ "description": "Represents a set of audit log actions." }).check(Schema.isMinLength(1)).check(Schema.isUnique()), "authors": Authors, "end": Schema.String.annotate({ "description": "Represents an end date in the yyyy-MM-ddThh:mm:ssZ format." }), "page": Schema.optionalKey(Schema.Number.annotate({ "description": "Page number.", "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0))), "page-size": Schema.optionalKey(Schema.Number.annotate({ "description": "Page size.", "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(50))), "start": Schema.String.annotate({ "description": "Represents a start date in the yyyy-MM-ddThh:mm:ssZ format." }) })
export type InvoiceOverviewDtoV1 = { readonly "amount"?: number, readonly "balance"?: number, readonly "billFrom"?: string, readonly "calculationType"?: CalculationType, readonly "clientAddress"?: string, readonly "clientId"?: string, readonly "clientName"?: string, readonly "companyId"?: string, readonly "containsImportedExpenses"?: boolean, readonly "containsImportedTimes"?: boolean, readonly "currency"?: string, readonly "discount"?: number, readonly "discountAmount"?: number, readonly "dueDate"?: string, readonly "id"?: string, readonly "issuedDate"?: string, readonly "items"?: ReadonlyArray<InvoiceItemDto>, readonly "note"?: string, readonly "number"?: string, readonly "paid"?: number, readonly "status"?: "UNSENT" | "SENT" | "PAID" | "PARTIALLY_PAID" | "VOID" | "OVERDUE", readonly "subject"?: string, readonly "subtotal"?: number, readonly "tax"?: number, readonly "tax2"?: number, readonly "tax2Amount"?: number, readonly "taxAmount"?: number, readonly "taxType"?: TaxType, readonly "userId"?: string, readonly "visibleZeroFields"?: VisibleZeroFieldsInvoice }
export const InvoiceOverviewDtoV1 = Schema.Struct({ "amount": Schema.optionalKey(Schema.Number.annotate({ "description": "Represents an invoice amount as long.", "format": "int64" }).check(Schema.isInt())), "balance": Schema.optionalKey(Schema.Number.annotate({ "description": "Represents an invoice balance amount as long.", "format": "int64" }).check(Schema.isInt())), "billFrom": Schema.optionalKey(Schema.String.annotate({ "description": "Represents to whom the invoice should be billed from." })), "calculationType": Schema.optionalKey(CalculationType), "clientAddress": Schema.optionalKey(Schema.String.annotate({ "description": "Represents client address." })), "clientId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents client identifier across the system." })), "clientName": Schema.optionalKey(Schema.String.annotate({ "description": "Represents client name for an invoice." })), "companyId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents company identifier across the system." })), "containsImportedExpenses": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether invoice contains imported expenses." })), "containsImportedTimes": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether invoice contains imported items." })), "currency": Schema.optionalKey(Schema.String.annotate({ "description": "Represents the currency used by the invoice." })), "discount": Schema.optionalKey(Schema.Number.annotate({ "description": "Represents an invoice discount amount as double.", "format": "double" }).check(Schema.isFinite())), "discountAmount": Schema.optionalKey(Schema.Number.annotate({ "description": "Represents an invoice discount amount as long.", "format": "int64" }).check(Schema.isInt())), "dueDate": Schema.optionalKey(Schema.String.annotate({ "description": "Represents an invoice due date in yyyy-MM-ddThh:mm:ssZ format.", "format": "date-time" })), "id": Schema.optionalKey(Schema.String.annotate({ "description": "Represents invoice identifier across the system." })), "issuedDate": Schema.optionalKey(Schema.String.annotate({ "description": "Represents an invoice issued date in yyyy-MM-ddThh:mm:ssZ format.", "format": "date-time" })), "items": Schema.optionalKey(Schema.Array(InvoiceItemDto).annotate({ "description": "Represents a list of invoice item datatransfer objects." })), "note": Schema.optionalKey(Schema.String.annotate({ "description": "Represents an invoice note." })), "number": Schema.optionalKey(Schema.String.annotate({ "description": "Represents an invoice number." })), "paid": Schema.optionalKey(Schema.Number.annotate({ "description": "Represents an invoice paid amount as long.", "format": "int64" }).check(Schema.isInt())), "status": Schema.optionalKey(Schema.Literals(["UNSENT", "SENT", "PAID", "PARTIALLY_PAID", "VOID", "OVERDUE"]).annotate({ "description": "Represents the status of an invoice." })), "subject": Schema.optionalKey(Schema.String.annotate({ "description": "Represents an invoice subject." })), "subtotal": Schema.optionalKey(Schema.Number.annotate({ "description": "Represents an invoice subtotal as long.", "format": "int64" }).check(Schema.isInt())), "tax": Schema.optionalKey(Schema.Number.annotate({ "description": "Represents an invoice tax amount as double.", "format": "double" }).check(Schema.isFinite())), "tax2": Schema.optionalKey(Schema.Number.annotate({ "description": "Represents an invoice tax amount as double.", "format": "double" }).check(Schema.isFinite())), "tax2Amount": Schema.optionalKey(Schema.Number.annotate({ "description": "Represents an invoice tax amount as long.", "format": "int64" }).check(Schema.isInt())), "taxAmount": Schema.optionalKey(Schema.Number.annotate({ "description": "Represents an invoice tax amount as long.", "format": "int64" }).check(Schema.isInt())), "taxType": Schema.optionalKey(TaxType), "userId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents user identifier across the system." })), "visibleZeroFields": Schema.optionalKey(VisibleZeroFieldsInvoice) })
export type RoleDetailsDtoV1 = { readonly "role"?: RoleDtoV1, readonly "userId"?: string, readonly "workspaceId"?: string }
export const RoleDetailsDtoV1 = Schema.Struct({ "role": Schema.optionalKey(RoleDtoV1), "userId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents workspace identifier across the system." })), "workspaceId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents workspace identifier across the system." })) })
export type UserCustomFieldValueFullDtoV1 = { readonly "customField"?: CustomFieldDtoV1, readonly "customFieldId"?: string, readonly "name"?: string, readonly "sourceType"?: "WORKSPACE" | "USER", readonly "type"?: "TXT" | "NUMBER" | "DROPDOWN_SINGLE" | "DROPDOWN_MULTIPLE" | "CHECKBOX" | "LINK", readonly "userId"?: string, readonly "value"?: {  } }
export const UserCustomFieldValueFullDtoV1 = Schema.Struct({ "customField": Schema.optionalKey(CustomFieldDtoV1), "customFieldId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents custom field identifier across the system." })), "name": Schema.optionalKey(Schema.String.annotate({ "description": "Represents user custom field name." })), "sourceType": Schema.optionalKey(Schema.Literals(["WORKSPACE", "USER"]).annotate({ "description": "Represents user custom field source type." })), "type": Schema.optionalKey(Schema.Literals(["TXT", "NUMBER", "DROPDOWN_SINGLE", "DROPDOWN_MULTIPLE", "CHECKBOX", "LINK"]).annotate({ "description": "Represents custom field type." })), "userId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents user identifier across the system." })), "value": Schema.optionalKey(Schema.Struct({  }).annotate({ "description": "Represents user custom field value." })) }).annotate({ "description": "Represents a list of value objects for user’s custom fields." })
export type HolidayDto = { readonly "automaticTimeEntryCreation"?: AutomaticTimeEntryCreationDto, readonly "color"?: string, readonly "datePeriod"?: DatePeriod, readonly "everyoneIncludingNew"?: boolean, readonly "id"?: string, readonly "name"?: string, readonly "occursAnnually"?: boolean, readonly "userGroupIds"?: ReadonlyArray<string>, readonly "userGroups"?: ReadonlyArray<EntityIdNameDto>, readonly "userIds"?: ReadonlyArray<string>, readonly "users"?: ReadonlyArray<EntityIdNameDto>, readonly "workspaceId"?: string }
export const HolidayDto = Schema.Struct({ "automaticTimeEntryCreation": Schema.optionalKey(AutomaticTimeEntryCreationDto), "color": Schema.optionalKey(Schema.String.annotate({ "description": "Provide color in format ^#(?:[0-9a-fA-F]{6}){1}$. Explanation: A valid color code should start with '#' and consist of six hexadecimal characters, representing a color in hexadecimal format. Color value is in standard RGB hexadecimal format." })), "datePeriod": Schema.optionalKey(DatePeriod), "everyoneIncludingNew": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether the holiday is shown to new users." })), "id": Schema.optionalKey(Schema.String.annotate({ "description": "Represents holiday identifier across the system." })), "name": Schema.optionalKey(Schema.String.annotate({ "description": "Represents the name of the holiday." })), "occursAnnually": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether the holiday occurs annually." })), "userGroupIds": Schema.optionalKey(Schema.Array(Schema.String.annotate({ "description": "Indicates which user groups are included." })).annotate({ "description": "Indicates which user groups are included." }).check(Schema.isUnique())), "userGroups": Schema.optionalKey(Schema.Array(EntityIdNameDto).annotate({ "description": "Contains names of user groups that are assigned to holiday." })), "userIds": Schema.optionalKey(Schema.Array(Schema.String.annotate({ "description": "Indicates which users are included." })).annotate({ "description": "Indicates which users are included." }).check(Schema.isUnique())), "users": Schema.optionalKey(Schema.Array(EntityIdNameDto).annotate({ "description": "Contains names of users that are assigned to holiday." })), "workspaceId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents workspace identifier across the system." })) })
export type PolicyDtoV1 = { readonly "allowHalfDay"?: boolean, readonly "allowNegativeBalance"?: boolean, readonly "approve"?: PolicyApprovalDto, readonly "archived"?: boolean, readonly "automaticAccrual"?: AutomaticAccrualDto, readonly "automaticTimeEntryCreation"?: AutomaticTimeEntryCreationDto, readonly "everyoneIncludingNew"?: boolean, readonly "id"?: string, readonly "name"?: string, readonly "negativeBalance"?: NegativeBalanceDto, readonly "projectId"?: string, readonly "timeUnit"?: "DAYS" | "HOURS", readonly "userGroupIds"?: ReadonlyArray<string>, readonly "userIds"?: ReadonlyArray<string>, readonly "workspaceId"?: string }
export const PolicyDtoV1 = Schema.Struct({ "allowHalfDay": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether the half day is allowed." })), "allowNegativeBalance": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether the negative balance is allowed." })), "approve": Schema.optionalKey(PolicyApprovalDto), "archived": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether the policy is archived." })), "automaticAccrual": Schema.optionalKey(AutomaticAccrualDto), "automaticTimeEntryCreation": Schema.optionalKey(AutomaticTimeEntryCreationDto), "everyoneIncludingNew": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether the policy is applied to future new users." })), "id": Schema.optionalKey(Schema.String.annotate({ "description": "Represents policy identifier across the system." })), "name": Schema.optionalKey(Schema.String.annotate({ "description": "Represents the name of the policy." })), "negativeBalance": Schema.optionalKey(NegativeBalanceDto), "projectId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents project identifier across the system." })), "timeUnit": Schema.optionalKey(Schema.Literals(["DAYS", "HOURS"]).annotate({ "description": "Represents the time unit of the policy." })), "userGroupIds": Schema.optionalKey(Schema.Array(Schema.String.annotate({ "description": "Represents user groups' identifiers across the system. Indicates which user groups are included in the policy." })).annotate({ "description": "Represents user groups' identifiers across the system. Indicates which user groups are included in the policy." }).check(Schema.isUnique())), "userIds": Schema.optionalKey(Schema.Array(Schema.String.annotate({ "description": "Represents users' identifiers across the system. Indicates which users are included in the policy." })).annotate({ "description": "Represents users' identifiers across the system. Indicates which users are included in the policy." }).check(Schema.isUnique())), "workspaceId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents workspace identifier across the system." })) })
export type CreateHolidayRequestV1 = { readonly "automaticTimeEntryCreation"?: AutomaticTimeEntryCreationRequest, readonly "color"?: string, readonly "datePeriod": DatePeriodRequest, readonly "everyoneIncludingNew"?: boolean, readonly "name": string, readonly "occursAnnually"?: boolean, readonly "userGroups"?: UserGroupIdsSchema, readonly "users"?: UserIdsSchema }
export const CreateHolidayRequestV1 = Schema.Struct({ "automaticTimeEntryCreation": Schema.optionalKey(AutomaticTimeEntryCreationRequest), "color": Schema.optionalKey(Schema.String.annotate({ "description": "Provide color in format ^#(?:[0-9a-fA-F]{6}){1}$. Explanation: A valid color code should start with '#' and consist of six hexadecimal characters, representing a color in hexadecimal format. Color value is in standard RGB hexadecimal format." }).check(Schema.isPattern(new RegExp("^#(?:[0-9a-fA-F]{6}){1}$")))), "datePeriod": DatePeriodRequest, "everyoneIncludingNew": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether the holiday is shown to new users." })), "name": Schema.String.annotate({ "description": "Provide the name of the holiday." }).check(Schema.isMinLength(2)).check(Schema.isMaxLength(100)), "occursAnnually": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether the holiday occurs annually." })), "userGroups": Schema.optionalKey(UserGroupIdsSchema), "users": Schema.optionalKey(UserIdsSchema) })
export type CreatePolicyRequestV1 = { readonly "allowHalfDay"?: boolean, readonly "allowNegativeBalance"?: boolean, readonly "approve": PolicyApprovalDto, readonly "archived"?: boolean, readonly "automaticAccrual"?: AutomaticAccrualRequest, readonly "automaticTimeEntryCreation"?: AutomaticTimeEntryCreationRequest, readonly "color"?: string, readonly "everyoneIncludingNew"?: boolean, readonly "hasExpiration"?: boolean, readonly "icon"?: "UMBRELLA" | "SNOWFLAKE" | "FAMILY" | "PLANE" | "STETHOSCOPE" | "HEALTH_METRICS" | "CHILDCARE" | "LUGGAGE" | "MONETIZATION" | "CALENDAR", readonly "name": string, readonly "negativeBalance"?: NegativeBalanceRequest, readonly "timeUnit"?: "DAYS" | "HOURS", readonly "userGroups"?: UserGroupIdsSchema, readonly "users"?: UserIdsSchema }
export const CreatePolicyRequestV1 = Schema.Struct({ "allowHalfDay": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether policy allows half days." })), "allowNegativeBalance": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether policy allows negative balances." })), "approve": PolicyApprovalDto, "archived": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether policy is archived." })), "automaticAccrual": Schema.optionalKey(AutomaticAccrualRequest), "automaticTimeEntryCreation": Schema.optionalKey(AutomaticTimeEntryCreationRequest), "color": Schema.optionalKey(Schema.String.annotate({ "description": "Provide color in format ^#(?:[0-9a-fA-F]{6}){1}$. Explanation: A valid color code should start with '#' and consist of six hexadecimal characters, representing a color in hexadecimal format. Color value is in standard RGB hexadecimal format." }).check(Schema.isPattern(new RegExp("^#(?:[0-9a-fA-F]{6}){1}$")))), "everyoneIncludingNew": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether the policy is to be applied to future new users." })), "hasExpiration": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether the policy balance should have expiration" })), "icon": Schema.optionalKey(Schema.Literals(["UMBRELLA", "SNOWFLAKE", "FAMILY", "PLANE", "STETHOSCOPE", "HEALTH_METRICS", "CHILDCARE", "LUGGAGE", "MONETIZATION", "CALENDAR"]).annotate({ "description": "Provide icon." })), "name": Schema.String.annotate({ "description": "Represents a name of new policy." }).check(Schema.isMinLength(2)).check(Schema.isMaxLength(100)), "negativeBalance": Schema.optionalKey(NegativeBalanceRequest), "timeUnit": Schema.optionalKey(Schema.Literals(["DAYS", "HOURS"]).annotate({ "description": "Indicates time unit of the policy. " })), "userGroups": Schema.optionalKey(UserGroupIdsSchema), "users": Schema.optionalKey(UserIdsSchema) })
export type UpdateHolidayRequestV1 = { readonly "automaticTimeEntryCreation"?: AutomaticTimeEntryCreationRequest, readonly "color"?: string, readonly "datePeriod": DatePeriodRequest, readonly "everyoneIncludingNew"?: boolean, readonly "name": string, readonly "occursAnnually": boolean, readonly "userGroups"?: ContainsUserGroupFilterRequest, readonly "users"?: ContainsUsersFilterRequestForHoliday }
export const UpdateHolidayRequestV1 = Schema.Struct({ "automaticTimeEntryCreation": Schema.optionalKey(AutomaticTimeEntryCreationRequest), "color": Schema.optionalKey(Schema.String.annotate({ "description": "Provide color in format ^#(?:[0-9a-fA-F]{6}){1}$. Explanation: A valid color code should start with '#' and consist of six hexadecimal characters, representing a color in hexadecimal format. Color value is in standard RGB hexadecimal format." }).check(Schema.isPattern(new RegExp("^#(?:[0-9a-fA-F]{6}){1}$")))), "datePeriod": DatePeriodRequest, "everyoneIncludingNew": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether the holiday is shown to new users." })), "name": Schema.String.annotate({ "description": "Provide the name you would like to use for updating the holiday." }).check(Schema.isMinLength(1)), "occursAnnually": Schema.Boolean.annotate({ "description": "Indicates whether the holiday occurs annually." }), "userGroups": Schema.optionalKey(ContainsUserGroupFilterRequest), "users": Schema.optionalKey(ContainsUsersFilterRequestForHoliday) })
export type UpdatePolicyRequestV1 = { readonly "allowHalfDay": boolean, readonly "allowNegativeBalance": boolean, readonly "approve": PolicyApprovalDto, readonly "archived": boolean, readonly "automaticAccrual"?: AutomaticAccrualRequest, readonly "automaticTimeEntryCreation"?: AutomaticTimeEntryCreationRequest, readonly "color"?: string, readonly "everyoneIncludingNew": boolean, readonly "hasExpiration": boolean, readonly "icon"?: "UMBRELLA" | "SNOWFLAKE" | "FAMILY" | "PLANE" | "STETHOSCOPE" | "HEALTH_METRICS" | "CHILDCARE" | "LUGGAGE" | "MONETIZATION" | "CALENDAR", readonly "name": string, readonly "negativeBalance"?: NegativeBalanceRequest, readonly "userGroups": UserGroupIdsSchema, readonly "users": UserIdsSchema }
export const UpdatePolicyRequestV1 = Schema.Struct({ "allowHalfDay": Schema.Boolean.annotate({ "description": "Indicates whether policy allows half day." }), "allowNegativeBalance": Schema.Boolean.annotate({ "description": "Indicates whether policy allows negative balance." }), "approve": PolicyApprovalDto, "archived": Schema.Boolean.annotate({ "description": "Indicates whether policy is archived." }), "automaticAccrual": Schema.optionalKey(AutomaticAccrualRequest), "automaticTimeEntryCreation": Schema.optionalKey(AutomaticTimeEntryCreationRequest), "color": Schema.optionalKey(Schema.String.annotate({ "description": "Provide color in format ^#(?:[0-9a-fA-F]{6}){1}$. Explanation: A valid color code should start with '#' and consist of six hexadecimal characters, representing a color in hexadecimal format. Color value is in standard RGB hexadecimal format." }).check(Schema.isPattern(new RegExp("^#(?:[0-9a-fA-F]{6}){1}$")))), "everyoneIncludingNew": Schema.Boolean.annotate({ "description": "Indicates whether the policy is shown to new users." }), "hasExpiration": Schema.Boolean.annotate({ "description": "Indicates whether the policy has expiration." }), "icon": Schema.optionalKey(Schema.Literals(["UMBRELLA", "SNOWFLAKE", "FAMILY", "PLANE", "STETHOSCOPE", "HEALTH_METRICS", "CHILDCARE", "LUGGAGE", "MONETIZATION", "CALENDAR"]).annotate({ "description": "Provide icon." })), "name": Schema.String.annotate({ "description": "Provide the name you would like to use for updating the policy." }).check(Schema.isMinLength(2)).check(Schema.isMaxLength(100)), "negativeBalance": Schema.optionalKey(NegativeBalanceRequest), "userGroups": UserGroupIdsSchema, "users": UserIdsSchema })
export type WorkspaceSettingsDtoV1 = { readonly "activeBillableHours"?: boolean, readonly "adminOnlyPages"?: "PROJECT" | "TEAM" | "REPORTS", readonly "automaticLock"?: AutomaticLockDtoV1, readonly "canSeeTimeSheet"?: boolean, readonly "canSeeTracker"?: boolean, readonly "currencyFormat"?: "CURRENCY_SPACE_VALUE" | "VALUE_SPACE_CURRENCY" | "CURRENCY_VALUE" | "VALUE_CURRENCY", readonly "defaultBillableProjects"?: boolean, readonly "durationFormat"?: "FULL" | "COMPACT" | "DECIMAL", readonly "entityCreationPermissions"?: EntityCreationPermissionsDtoV1, readonly "forceDescription"?: boolean, readonly "forceProjects"?: boolean, readonly "forceTags"?: boolean, readonly "forceTasks"?: boolean, readonly "isProjectPublicByDefault"?: boolean, readonly "lockTimeEntries"?: string, readonly "lockTimeZone"?: string, readonly "multiFactorEnabled"?: boolean, readonly "numberFormat"?: "COMMA_PERIOD" | "PERIOD_COMMA" | "QUOTATION_MARK_PERIOD" | "SPACE_COMMA", readonly "onlyAdminsCanChangeBillableStatus"?: boolean, readonly "onlyAdminsCreateProject"?: boolean, readonly "onlyAdminsCreateTag"?: boolean, readonly "onlyAdminsCreateTask"?: boolean, readonly "onlyAdminsSeeAllTimeEntries"?: boolean, readonly "onlyAdminsSeeBillableRates"?: boolean, readonly "onlyAdminsSeeDashboard"?: boolean, readonly "onlyAdminsSeePublicProjectsEntries"?: boolean, readonly "projectFavorites"?: boolean, readonly "projectGroupingLabel"?: string, readonly "projectLabel"?: string, readonly "projectPickerSpecialFilter"?: boolean, readonly "round"?: RoundDto, readonly "taskLabel"?: string, readonly "timeRoundingInReports"?: boolean, readonly "timeTrackingMode"?: "DEFAULT" | "STOPWATCH_ONLY", readonly "trackTimeDownToSecond"?: boolean, readonly "workingDays"?: ReadonlyArray<"MONDAY" | "TUESDAY" | "WEDNESDAY" | "THURSDAY" | "FRIDAY" | "SATURDAY" | "SUNDAY"> }
export const WorkspaceSettingsDtoV1 = Schema.Struct({ "activeBillableHours": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether billable hours is active." })), "adminOnlyPages": Schema.optionalKey(Schema.Literals(["PROJECT", "TEAM", "REPORTS"]).annotate({ "description": "Represents a unique list of protected page enums." })), "automaticLock": Schema.optionalKey(AutomaticLockDtoV1), "canSeeTimeSheet": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether timesheets are visible or not." })), "canSeeTracker": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether time trackers are visible or not." })), "currencyFormat": Schema.optionalKey(Schema.Literals(["CURRENCY_SPACE_VALUE", "VALUE_SPACE_CURRENCY", "CURRENCY_VALUE", "VALUE_CURRENCY"]).annotate({ "description": "Represents a clockify currency format enum." })), "defaultBillableProjects": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether projects are billable by default." })), "durationFormat": Schema.optionalKey(Schema.Literals(["FULL", "COMPACT", "DECIMAL"]).annotate({ "description": "Represents a clockify duration format enum. Used to set Duration format instead of setting decimalFormat and trackTimeDownToSecond." })), "entityCreationPermissions": Schema.optionalKey(EntityCreationPermissionsDtoV1), "forceDescription": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether description are forced or not." })), "forceProjects": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether projects are forced or not." })), "forceTags": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether tags are forced or not." })), "forceTasks": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether tasks are forced or not." })), "isProjectPublicByDefault": Schema.optionalKey(Schema.Boolean), "lockTimeEntries": Schema.optionalKey(Schema.String), "lockTimeZone": Schema.optionalKey(Schema.String), "multiFactorEnabled": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether two-factor authentication is enabled or not." })), "numberFormat": Schema.optionalKey(Schema.Literals(["COMMA_PERIOD", "PERIOD_COMMA", "QUOTATION_MARK_PERIOD", "SPACE_COMMA"]).annotate({ "description": "Represents a clockify number format enum." })), "onlyAdminsCanChangeBillableStatus": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether only admins can change billable status." })), "onlyAdminsCreateProject": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether only admins can create projects." })), "onlyAdminsCreateTag": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether only admins can create tags." })), "onlyAdminsCreateTask": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether only admins can create task." })), "onlyAdminsSeeAllTimeEntries": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether only admins can see all time entries." })), "onlyAdminsSeeBillableRates": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether only admins can see billable rates." })), "onlyAdminsSeeDashboard": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether only admins can see dashboard." })), "onlyAdminsSeePublicProjectsEntries": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether only admins can see public project entries." })), "projectFavorites": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether project favorites are allowed." })), "projectGroupingLabel": Schema.optionalKey(Schema.String.annotate({ "description": "Represents a project grouping label." })), "projectLabel": Schema.optionalKey(Schema.String.annotate({ "description": "Represents a project label." })), "projectPickerSpecialFilter": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether project picker special filter is enabled." })), "round": Schema.optionalKey(RoundDto), "taskLabel": Schema.optionalKey(Schema.String.annotate({ "description": "Represents a task label." })), "timeRoundingInReports": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether time rounding is enabled in reports." })), "timeTrackingMode": Schema.optionalKey(Schema.Literals(["DEFAULT", "STOPWATCH_ONLY"]).annotate({ "description": "Represents a time tracking mode enum." })), "trackTimeDownToSecond": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether time tracking is seconds-accurate. This is now deprecated and durationFormat can now be used to manage Time Duration Format." })), "workingDays": Schema.optionalKey(Schema.Array(Schema.Literals(["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"]).annotate({ "description": "Represents a list of working days." })).annotate({ "description": "Represents a list of working days." }).check(Schema.isUnique())) }).annotate({ "description": "Workspace settings also include Time Duration Format settings.\n\nSetting Time Duration Format by changing the boolean fields\ndecimalFormat and trackTimeDownToSecond is now deprecated.\n\nTime Duration Format can be set by durationFormat enum field.\n\nThree different Time Duration modes will still map the boolean fields:\n\n    1. Full (hh:mm:ss) -> decimalFormat = false, trackTimeDownToSecond = true,\n\n    2. Compact (h:mm) -> decimalFormat = false, trackTimeDownToSecond = false,\n\n    3. Decimal (h:hh) -> decimalFormat = true, trackTimeDownToSecond = true\n\n" })
export type ProjectRequest = { readonly "billable"?: boolean, readonly "clientId"?: string, readonly "color"?: string, readonly "costRate"?: CostRateRequestV1, readonly "estimate"?: EstimateRequest, readonly "hourlyRate"?: HourlyRateRequestV1, readonly "isPublic"?: boolean, readonly "memberships"?: ReadonlyArray<MembershipRequest>, readonly "name": string, readonly "note"?: string, readonly "tasks"?: ReadonlyArray<TaskRequest> }
export const ProjectRequest = Schema.Struct({ "billable": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether project is billable or not." })), "clientId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents client identifier across the system." })), "color": Schema.optionalKey(Schema.String.annotate({ "description": "Color format ^#(?:[0-9a-fA-F]{6}){1}$. Explanation: A valid color code should start with '#' and consist of six hexadecimal characters, representing a color in hexadecimal format. Color value is in standard RGB hexadecimal format." }).check(Schema.isPattern(new RegExp("^#(?:[0-9a-fA-F]{6}){1}$")))), "costRate": Schema.optionalKey(CostRateRequestV1), "estimate": Schema.optionalKey(EstimateRequest), "hourlyRate": Schema.optionalKey(HourlyRateRequestV1), "isPublic": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether project is public or not." })), "memberships": Schema.optionalKey(Schema.Array(MembershipRequest).annotate({ "description": "Represents a list of membership request objects." })), "name": Schema.String.annotate({ "description": "Represents a project name." }).check(Schema.isMinLength(2)).check(Schema.isMaxLength(250)), "note": Schema.optionalKey(Schema.String.annotate({ "description": "Represents project note." }).check(Schema.isMaxLength(16384))), "tasks": Schema.optionalKey(Schema.Array(TaskRequest).annotate({ "description": "Represents a list of task request objects." })) })
export type UpdateProjectMembershipsRequest = { readonly "memberships": ReadonlyArray<UserIdWithRatesRequest>, readonly "userGroups"?: UserGroupIdsSchema }
export const UpdateProjectMembershipsRequest = Schema.Struct({ "memberships": Schema.Array(UserIdWithRatesRequest).annotate({ "description": "Represents a list of users with id and rates request objects." }), "userGroups": Schema.optionalKey(UserGroupIdsSchema) })
export type TimeOffRequestFullV1Dto = { readonly "balance"?: number, readonly "balanceDiff"?: number, readonly "createdAt"?: string, readonly "id"?: string, readonly "note"?: string, readonly "policyId"?: string, readonly "policyName"?: string, readonly "requesterUserId"?: string, readonly "requesterUserName"?: string, readonly "status"?: TimeOffRequestStatus, readonly "timeOffPeriod"?: TimeOffRequestPeriodDto, readonly "timeUnit"?: "DAYS" | "HOURS", readonly "userEmail"?: string, readonly "userId"?: string, readonly "userName"?: string, readonly "userTimeZone"?: string, readonly "workspaceId"?: string }
export const TimeOffRequestFullV1Dto = Schema.Struct({ "balance": Schema.optionalKey(Schema.Number.annotate({ "description": "Represents the time off balance.", "format": "double" }).check(Schema.isFinite())), "balanceDiff": Schema.optionalKey(Schema.Number.annotate({ "description": "Represents the balance difference.", "format": "double" }).check(Schema.isFinite())), "createdAt": Schema.optionalKey(Schema.String.annotate({ "description": "Represents the date when time off request is created. It is in format YYYY-MM-DDTHH:MM:SS.ssssssZ", "format": "date-time" })), "id": Schema.optionalKey(Schema.String.annotate({ "description": "Represents time off requester identifier across the system." })), "note": Schema.optionalKey(Schema.String.annotate({ "description": "Represents the note of the time off request." })), "policyId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents policy identifier across the system." })), "policyName": Schema.optionalKey(Schema.String.annotate({ "description": "Represents the policy name of the time off request." })), "requesterUserId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents requester user's id." })), "requesterUserName": Schema.optionalKey(Schema.String.annotate({ "description": "Represents requester user's username." })), "status": Schema.optionalKey(TimeOffRequestStatus), "timeOffPeriod": Schema.optionalKey(TimeOffRequestPeriodDto), "timeUnit": Schema.optionalKey(Schema.Literals(["DAYS", "HOURS"]).annotate({ "description": "Represents the time unit of the time off request." })), "userEmail": Schema.optionalKey(Schema.String.annotate({ "description": "Represents user's email" })), "userId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents user identifier across the system." })), "userName": Schema.optionalKey(Schema.String.annotate({ "description": "Represents user's username." })), "userTimeZone": Schema.optionalKey(Schema.String.annotate({ "description": "Represents user's time zone" })), "workspaceId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents workspace identifier across the system." })) }).annotate({ "description": "Represents the array of time off requests." })
export type TimeOffRequestV1Dto = { readonly "balanceDiff"?: number, readonly "createdAt"?: string, readonly "id"?: string, readonly "note"?: string, readonly "policyId"?: string, readonly "status"?: TimeOffRequestStatus, readonly "timeOffPeriod"?: TimeOffRequestPeriodDto, readonly "userId"?: string, readonly "workspaceId"?: string }
export const TimeOffRequestV1Dto = Schema.Struct({ "balanceDiff": Schema.optionalKey(Schema.Number.annotate({ "description": "Represents the balance difference", "format": "double" }).check(Schema.isFinite())), "createdAt": Schema.optionalKey(Schema.String.annotate({ "description": "Represents the date when time off request is created. Date is in format YYYY-MM-DDTHH:MM:SS.ssssssZ", "format": "date-time" })), "id": Schema.optionalKey(Schema.String.annotate({ "description": "Represents time off requester identifier across the system." })), "note": Schema.optionalKey(Schema.String.annotate({ "description": "Represents the note of the time off request." })), "policyId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents policy identifier across the system." })), "status": Schema.optionalKey(TimeOffRequestStatus), "timeOffPeriod": Schema.optionalKey(TimeOffRequestPeriodDto), "userId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents user identifier across the system." })), "workspaceId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents workspace identifier across the system." })) })
export type CreateTimeOffRequestV1Request = { readonly "note"?: string, readonly "timeOffPeriod": TimeOffRequestPeriodV1Request }
export const CreateTimeOffRequestV1Request = Schema.Struct({ "note": Schema.optionalKey(Schema.String.annotate({ "description": "Provide the note you would like to use for creating the time off request." })), "timeOffPeriod": TimeOffRequestPeriodV1Request })
export type ProjectDtoImplV1 = { readonly "archived"?: boolean, readonly "billable"?: boolean, readonly "budgetEstimate"?: EstimateWithOptionsDto, readonly "clientId"?: string, readonly "clientName"?: string, readonly "color"?: string, readonly "costRate"?: RateDtoV1, readonly "duration"?: string, readonly "estimate"?: EstimateDtoV1, readonly "estimateReset"?: EstimateResetDto, readonly "hourlyRate"?: RateDtoV1, readonly "id"?: string, readonly "isPublic"?: boolean, readonly "isTemplate"?: boolean, readonly "memberships"?: ReadonlyArray<MembershipDtoV1>, readonly "name"?: string, readonly "note"?: string, readonly "public"?: boolean, readonly "template"?: boolean, readonly "timeEstimate"?: TimeEstimateDto, readonly "workspaceId"?: string }
export const ProjectDtoImplV1 = Schema.Struct({ "archived": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether project is archived or not." })), "billable": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether project is billable or not." })), "budgetEstimate": Schema.optionalKey(EstimateWithOptionsDto), "clientId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents client identifier across the system." })), "clientName": Schema.optionalKey(Schema.String.annotate({ "description": "Represents client name." })), "color": Schema.optionalKey(Schema.String.annotate({ "description": "Color format ^#(?:[0-9a-fA-F]{6}){1}$. Explanation: A valid color code should start with '#' and consist of six hexadecimal characters, representing a color in hexadecimal format. Color value is in standard RGB hexadecimal format." })), "costRate": Schema.optionalKey(RateDtoV1), "duration": Schema.optionalKey(Schema.String.annotate({ "description": "Represents project duration in milliseconds." })), "estimate": Schema.optionalKey(EstimateDtoV1), "estimateReset": Schema.optionalKey(EstimateResetDto), "hourlyRate": Schema.optionalKey(RateDtoV1), "id": Schema.optionalKey(Schema.String.annotate({ "description": "Represents project identifier across the system." })), "isPublic": Schema.optionalKey(Schema.Boolean.annotate({ "writeOnly": true })), "isTemplate": Schema.optionalKey(Schema.Boolean.annotate({ "writeOnly": true })), "memberships": Schema.optionalKey(Schema.Array(MembershipDtoV1).annotate({ "description": "Represents a list of membership objects." })), "name": Schema.optionalKey(Schema.String.annotate({ "description": "Represents a project name." })), "note": Schema.optionalKey(Schema.String.annotate({ "description": "Represents project note." })), "public": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether project is public or not." })), "template": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether project is a template or not." })), "timeEstimate": Schema.optionalKey(TimeEstimateDto), "workspaceId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents workspace identifier across the system." })) })
export type ProjectDtoV1 = { readonly "archived": boolean, readonly "billable": boolean, readonly "budgetEstimate"?: EstimateWithOptionsDto, readonly "color": string, readonly "costRate"?: RateDtoV1, readonly "duration"?: string, readonly "estimate"?: EstimateDtoV1, readonly "hourlyRate"?: RateDtoV1, readonly "id": string, readonly "memberships"?: ReadonlyArray<MembershipDtoV1>, readonly "name": string, readonly "note"?: string, readonly "public"?: boolean, readonly "template"?: boolean, readonly "timeEstimate"?: TimeEstimateDto, readonly "workspaceId": string }
export const ProjectDtoV1 = Schema.Struct({ "archived": Schema.Boolean.annotate({ "description": "Indicates whether project is archived or not." }), "billable": Schema.Boolean.annotate({ "description": "Indicates whether project is billable or not." }), "budgetEstimate": Schema.optionalKey(EstimateWithOptionsDto), "color": Schema.String.annotate({ "description": "Color format ^#(?:[0-9a-fA-F]{6}){1}$. Explanation: A valid color code should start with '#' and consist of six hexadecimal characters, representing a color in hexadecimal format. Color value is in standard RGB hexadecimal format." }), "costRate": Schema.optionalKey(RateDtoV1), "duration": Schema.optionalKey(Schema.String.annotate({ "description": "Represents project duration in milliseconds." })), "estimate": Schema.optionalKey(EstimateDtoV1), "hourlyRate": Schema.optionalKey(RateDtoV1), "id": Schema.String.annotate({ "description": "Represents project identifier across the system." }), "memberships": Schema.optionalKey(Schema.Array(MembershipDtoV1).annotate({ "description": "Represents a list of membership objects." })), "name": Schema.String, "note": Schema.optionalKey(Schema.String), "public": Schema.optionalKey(Schema.Boolean), "template": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether project is a template or not." })), "timeEstimate": Schema.optionalKey(TimeEstimateDto), "workspaceId": Schema.String })
export type UserDtoV1 = { readonly "activeWorkspace"?: string, readonly "customFields"?: ReadonlyArray<UserCustomFieldValueDtoV1>, readonly "defaultWorkspace"?: string, readonly "email": string, readonly "id": string, readonly "memberships"?: ReadonlyArray<MembershipDtoV1>, readonly "name": string, readonly "profilePicture"?: string, readonly "settings"?: UserSettingsDtoV1, readonly "status"?: AccountStatus }
export const UserDtoV1 = Schema.Struct({ "activeWorkspace": Schema.optionalKey(Schema.String.annotate({ "description": "Represents user's active workspace identifier across the system." })), "customFields": Schema.optionalKey(Schema.Array(UserCustomFieldValueDtoV1).annotate({ "description": "Represents a list of value objects for user’s custom fields." })), "defaultWorkspace": Schema.optionalKey(Schema.String.annotate({ "description": "Represents user default workspace identifier across the system." })), "email": Schema.String.annotate({ "description": "Represents email address of the user." }), "id": Schema.String.annotate({ "description": "Represents user identifier across the system." }), "memberships": Schema.optionalKey(Schema.Array(MembershipDtoV1).annotate({ "description": "Represents a list of membership objects." })), "name": Schema.String.annotate({ "description": "Represents name of the user." }), "profilePicture": Schema.optionalKey(Schema.String.annotate({ "description": "Represents profile image path of the user." })), "settings": Schema.optionalKey(UserSettingsDtoV1), "status": Schema.optionalKey(AccountStatus) })
export type ExpensesWithCountDtoV1 = { readonly "count"?: number, readonly "expenses"?: ReadonlyArray<ExpenseHydratedDtoV1> }
export const ExpensesWithCountDtoV1 = Schema.Struct({ "count": Schema.optionalKey(Schema.Number.annotate({ "description": "Represent result count.", "format": "int32" }).check(Schema.isInt())), "expenses": Schema.optionalKey(Schema.Array(ExpenseHydratedDtoV1).annotate({ "description": "Represent a list of hydrated expense objects." })) }).annotate({ "description": "Represents an expense with count data transfer object." })
export type ApprovalDetailsDtoV1 = { readonly "approvalRequest"?: ApprovalRequestDtoV1, readonly "approvedTime"?: string, readonly "billableAmount"?: number, readonly "billableTime"?: string, readonly "breakTime"?: string, readonly "costAmount"?: number, readonly "entries"?: ReadonlyArray<TimeEntryInfoDto>, readonly "expenseTotal"?: number, readonly "expenses"?: ReadonlyArray<ExpenseHydratedDto>, readonly "pendingTime"?: string, readonly "trackedTime"?: string }
export const ApprovalDetailsDtoV1 = Schema.Struct({ "approvalRequest": Schema.optionalKey(ApprovalRequestDtoV1), "approvedTime": Schema.optionalKey(Schema.String.annotate({ "description": "Represents a time duration." })), "billableAmount": Schema.optionalKey(Schema.Number.annotate({ "format": "double" }).check(Schema.isFinite())), "billableTime": Schema.optionalKey(Schema.String.annotate({ "description": "Represents a time duration." })), "breakTime": Schema.optionalKey(Schema.String.annotate({ "description": "Represents a time duration." })), "costAmount": Schema.optionalKey(Schema.Number.annotate({ "description": "Represents an amount.", "format": "double" }).check(Schema.isFinite())), "entries": Schema.optionalKey(Schema.Array(TimeEntryInfoDto).annotate({ "description": "Represents a list of time entry info data transfer objects." })), "expenseTotal": Schema.optionalKey(Schema.Number.annotate({ "description": "Represents an amount.", "format": "double" }).check(Schema.isFinite())), "expenses": Schema.optionalKey(Schema.Array(ExpenseHydratedDto).annotate({ "description": "Represents a list of expense hydrated data transfer objects." })), "pendingTime": Schema.optionalKey(Schema.String.annotate({ "description": "Represents a time duration." })), "trackedTime": Schema.optionalKey(Schema.String.annotate({ "description": "Represents a time duration." })) })
export type TemplateDtoImpl = { readonly "entries"?: ReadonlyArray<TimeEntryWithCustomFieldsDto>, readonly "id"?: string, readonly "name"?: string, readonly "projectsAndTasks"?: ReadonlyArray<ProjectTaskTupleDto>, readonly "userId"?: string, readonly "weekStart"?: string, readonly "workspaceId"?: string }
export const TemplateDtoImpl = Schema.Struct({ "entries": Schema.optionalKey(Schema.Array(TimeEntryWithCustomFieldsDto).annotate({ "description": "Represents a set of template time entries." })), "id": Schema.optionalKey(Schema.String.annotate({ "description": "Represents a template identifier across the system." })), "name": Schema.optionalKey(Schema.String.annotate({ "description": "Represents a template name." })), "projectsAndTasks": Schema.optionalKey(Schema.Array(ProjectTaskTupleDto).annotate({ "description": "Represents a list of template's projects and tasks." })), "userId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents a user identifier across the system." })), "weekStart": Schema.optionalKey(Schema.String.annotate({ "description": "Represents a day of the week.", "format": "date" })), "workspaceId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents a workspace identifier across the system." })) })
export type AddLimitedUsersRequest = { readonly "users": ReadonlyArray<LimitedUserRequest> }
export const AddLimitedUsersRequest = Schema.Struct({ "users": Schema.Array(LimitedUserRequest).check(Schema.isMinLength(1)).check(Schema.isMaxLength(250)) })
export type InvoiceInfoResponseDtoV1 = { readonly "invoices"?: ReadonlyArray<InvoiceInfoV1>, readonly "total"?: number }
export const InvoiceInfoResponseDtoV1 = Schema.Struct({ "invoices": Schema.optionalKey(Schema.Array(InvoiceInfoV1).annotate({ "description": "Represents a list of invoice info." })), "total": Schema.optionalKey(Schema.Number.annotate({ "description": "Represents the total invoice count.", "format": "int64" }).check(Schema.isInt())) })
export type WebhooksDtoV1 = { readonly "webhooks"?: ReadonlyArray<WebhookDtoV1>, readonly "workspaceWebhookCount"?: number }
export const WebhooksDtoV1 = Schema.Struct({ "webhooks": Schema.optionalKey(Schema.Array(WebhookDtoV1).annotate({ "description": "Represents a list of webhook objects for the workspace." })), "workspaceWebhookCount": Schema.optionalKey(Schema.Number.annotate({ "description": "Represents number of webhooks for the workspace.", "format": "int32" }).check(Schema.isInt())) })
export type AttendanceReportFilterV1 = { readonly "amountShown"?: "EARNED" | "COST" | "PROFIT" | "HIDE_AMOUNT" | "EXPORT", readonly "amounts"?: ReadonlyArray<"EARNED" | "COST" | "PROFIT" | "HIDE_AMOUNT" | "EXPORT">, readonly "approvalState"?: "APPROVED" | "UNAPPROVED" | "ALL", readonly "archived"?: boolean, readonly "attendanceFilter": AttendanceFilterV1, readonly "billable"?: boolean, readonly "clients"?: ContainsArchivedFilterV1, readonly "currency"?: ContainsArchivedFilterV1, readonly "customFields"?: ReadonlyArray<CustomFieldFilterV1>, readonly "dateFormat"?: string, readonly "dateRangeEnd": string, readonly "dateRangeStart": string, readonly "dateRangeType"?: "ABSOLUTE" | "TODAY" | "YESTERDAY" | "THIS_WEEK" | "LAST_WEEK" | "PAST_TWO_WEEKS" | "THIS_MONTH" | "LAST_MONTH" | "THIS_YEAR" | "LAST_YEAR", readonly "description"?: string, readonly "detailedFilter"?: DetailedFilterV1, readonly "exportType"?: "JSON" | "JSON_V1" | "PDF" | "CSV" | "XLSX" | "ZIP", readonly "invoicingState"?: "INVOICED" | "UNINVOICED" | "ALL", readonly "projects"?: ContainsArchivedFilterV1, readonly "rounding"?: boolean, readonly "sortOrder"?: "ASCENDING" | "DESCENDING", readonly "summaryFilter"?: SummaryFilterV1, readonly "tags"?: ContainsTagFilterV1, readonly "tasks"?: ContainsTaskFilterV1, readonly "timeFormat"?: string, readonly "timeZone"?: string, readonly "userGroups"?: ContainsUsersFilterV1, readonly "userLocale"?: string, readonly "users"?: ContainsUsersFilterV1, readonly "weekStart"?: "MONDAY" | "TUESDAY" | "WEDNESDAY" | "THURSDAY" | "FRIDAY" | "SATURDAY" | "SUNDAY", readonly "weeklyFilter"?: WeeklyFilterV1, readonly "withoutDescription"?: boolean, readonly "zoomLevel"?: "WEEK" | "MONTH" | "YEAR" }
export const AttendanceReportFilterV1 = Schema.Struct({ "amountShown": Schema.optionalKey(Schema.Literals(["EARNED", "COST", "PROFIT", "HIDE_AMOUNT", "EXPORT"]).annotate({ "description": "If provided, you'll get filtered result including reports with provided amount shown." })), "amounts": Schema.optionalKey(Schema.Array(Schema.Literals(["EARNED", "COST", "PROFIT", "HIDE_AMOUNT", "EXPORT"]))), "approvalState": Schema.optionalKey(Schema.Literals(["APPROVED", "UNAPPROVED", "ALL"]).annotate({ "description": "If provided, you'll get filtered result including reports with provided approval state." })), "archived": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether the report is archived" })), "attendanceFilter": AttendanceFilterV1, "billable": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether the report is billable" })), "clients": Schema.optionalKey(ContainsArchivedFilterV1), "currency": Schema.optionalKey(ContainsArchivedFilterV1), "customFields": Schema.optionalKey(Schema.Array(CustomFieldFilterV1)), "dateFormat": Schema.optionalKey(Schema.String.annotate({ "description": "Provide date in format YYYY-MM-DD" })), "dateRangeEnd": Schema.String.annotate({ "description": "Provide date in format YYYY-MM-DDTHH:MM:SS.ssssss. The system interprets this value based on the user's timezone (provided in the timeZone request parameter or the timezone configured in the user profile)" }).check(Schema.isMinLength(1)), "dateRangeStart": Schema.String.annotate({ "description": "Provide date in format YYYY-MM-DDTHH:MM:SS.ssssss. The system interprets this value based on the user's timezone (provided in the timeZone request parameter or the timezone configured in the user profile)" }).check(Schema.isMinLength(1)), "dateRangeType": Schema.optionalKey(Schema.Literals(["ABSOLUTE", "TODAY", "YESTERDAY", "THIS_WEEK", "LAST_WEEK", "PAST_TWO_WEEKS", "THIS_MONTH", "LAST_MONTH", "THIS_YEAR", "LAST_YEAR"]).annotate({ "description": "Provide the date range type" })), "description": Schema.optionalKey(Schema.String.annotate({ "description": "Represents search term for filtering report entries by description" })), "detailedFilter": Schema.optionalKey(DetailedFilterV1), "exportType": Schema.optionalKey(Schema.Literals(["JSON", "JSON_V1", "PDF", "CSV", "XLSX", "ZIP"]).annotate({ "description": "If provided, you'll get filtered result including reports with provided export type." })), "invoicingState": Schema.optionalKey(Schema.Literals(["INVOICED", "UNINVOICED", "ALL"]).annotate({ "description": "If provided, you'll get filtered result including reports with provided invoicing state." })), "projects": Schema.optionalKey(ContainsArchivedFilterV1), "rounding": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether the report filter is rounding" })), "sortOrder": Schema.optionalKey(Schema.Literals(["ASCENDING", "DESCENDING"]).annotate({ "description": "If provided, you'll get sorted result by provided sort order." })), "summaryFilter": Schema.optionalKey(SummaryFilterV1), "tags": Schema.optionalKey(ContainsTagFilterV1), "tasks": Schema.optionalKey(ContainsTaskFilterV1), "timeFormat": Schema.optionalKey(Schema.String.annotate({ "description": "Provide time in format THH:MM:SS.ssssss" })), "timeZone": Schema.optionalKey(Schema.String.annotate({ "description": "If provided, you'll get filtered result including reports with provided time zone." })), "userGroups": Schema.optionalKey(ContainsUsersFilterV1), "userLocale": Schema.optionalKey(Schema.String.annotate({ "description": "If provided, you'll get filtered result including reports with provided user locale." })), "users": Schema.optionalKey(ContainsUsersFilterV1), "weekStart": Schema.optionalKey(Schema.Literals(["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"]).annotate({ "description": "If provided, you'll get filtered result including reports with provided week start." })), "weeklyFilter": Schema.optionalKey(WeeklyFilterV1), "withoutDescription": Schema.optionalKey(Schema.Boolean.annotate({ "description": "If set to 'true', report will only include entries with empty description" })), "zoomLevel": Schema.optionalKey(Schema.Literals(["WEEK", "MONTH", "YEAR"]).annotate({ "description": "If provided, you'll get filtered result including reports with provided zoom level." })) })
export type DetailedReportFilterV1 = { readonly "amountShown"?: "EARNED" | "COST" | "PROFIT" | "HIDE_AMOUNT" | "EXPORT", readonly "amounts"?: ReadonlyArray<"EARNED" | "COST" | "PROFIT" | "HIDE_AMOUNT" | "EXPORT">, readonly "approvalState"?: "APPROVED" | "UNAPPROVED" | "ALL", readonly "archived"?: boolean, readonly "attendanceFilter"?: AttendanceFilterV1, readonly "billable"?: boolean, readonly "clients"?: ContainsArchivedFilterV1, readonly "currency"?: ContainsArchivedFilterV1, readonly "customFields"?: ReadonlyArray<CustomFieldFilterV1>, readonly "dateFormat"?: string, readonly "dateRangeEnd": string, readonly "dateRangeStart": string, readonly "dateRangeType"?: "ABSOLUTE" | "TODAY" | "YESTERDAY" | "THIS_WEEK" | "LAST_WEEK" | "PAST_TWO_WEEKS" | "THIS_MONTH" | "LAST_MONTH" | "THIS_YEAR" | "LAST_YEAR", readonly "description"?: string, readonly "detailedFilter": DetailedFilterV1, readonly "exportType"?: "JSON" | "JSON_V1" | "PDF" | "CSV" | "XLSX" | "ZIP", readonly "invoicingState"?: "INVOICED" | "UNINVOICED" | "ALL", readonly "projects"?: ContainsArchivedFilterV1, readonly "rounding"?: boolean, readonly "sortOrder"?: "ASCENDING" | "DESCENDING", readonly "summaryFilter"?: SummaryFilterV1, readonly "tags"?: ContainsTagFilterV1, readonly "tasks"?: ContainsTaskFilterV1, readonly "timeFormat"?: string, readonly "timeZone"?: string, readonly "userCustomFields"?: ReadonlyArray<CustomFieldFilterV1>, readonly "userGroups"?: ContainsUsersFilterV1, readonly "userLocale"?: string, readonly "users"?: ContainsUsersFilterV1, readonly "weekStart"?: "MONDAY" | "TUESDAY" | "WEDNESDAY" | "THURSDAY" | "FRIDAY" | "SATURDAY" | "SUNDAY", readonly "weeklyFilter"?: WeeklyFilterV1, readonly "withoutDescription"?: boolean, readonly "zoomLevel"?: "WEEK" | "MONTH" | "YEAR" }
export const DetailedReportFilterV1 = Schema.Struct({ "amountShown": Schema.optionalKey(Schema.Literals(["EARNED", "COST", "PROFIT", "HIDE_AMOUNT", "EXPORT"]).annotate({ "description": "If provided, you'll get filtered result including reports with provided amount shown." })), "amounts": Schema.optionalKey(Schema.Array(Schema.Literals(["EARNED", "COST", "PROFIT", "HIDE_AMOUNT", "EXPORT"]))), "approvalState": Schema.optionalKey(Schema.Literals(["APPROVED", "UNAPPROVED", "ALL"]).annotate({ "description": "If provided, you'll get filtered result including reports with provided approval state." })), "archived": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether the report is archived" })), "attendanceFilter": Schema.optionalKey(AttendanceFilterV1), "billable": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether the report is billable" })), "clients": Schema.optionalKey(ContainsArchivedFilterV1), "currency": Schema.optionalKey(ContainsArchivedFilterV1), "customFields": Schema.optionalKey(Schema.Array(CustomFieldFilterV1)), "dateFormat": Schema.optionalKey(Schema.String.annotate({ "description": "Provide date in format YYYY-MM-DD" })), "dateRangeEnd": Schema.String.annotate({ "description": "Provide date in format YYYY-MM-DDTHH:MM:SS.ssssss. The system interprets this value based on the user's timezone (provided in the timeZone request parameter or the timezone configured in the user profile)" }).check(Schema.isMinLength(1)), "dateRangeStart": Schema.String.annotate({ "description": "Provide date in format YYYY-MM-DDTHH:MM:SS.ssssss. The system interprets this value based on the user's timezone (provided in the timeZone request parameter or the timezone configured in the user profile)" }).check(Schema.isMinLength(1)), "dateRangeType": Schema.optionalKey(Schema.Literals(["ABSOLUTE", "TODAY", "YESTERDAY", "THIS_WEEK", "LAST_WEEK", "PAST_TWO_WEEKS", "THIS_MONTH", "LAST_MONTH", "THIS_YEAR", "LAST_YEAR"]).annotate({ "description": "Provide the date range type" })), "description": Schema.optionalKey(Schema.String.annotate({ "description": "Represents search term for filtering report entries by description" })), "detailedFilter": DetailedFilterV1, "exportType": Schema.optionalKey(Schema.Literals(["JSON", "JSON_V1", "PDF", "CSV", "XLSX", "ZIP"]).annotate({ "description": "If provided, you'll get filtered result including reports with provided export type." })), "invoicingState": Schema.optionalKey(Schema.Literals(["INVOICED", "UNINVOICED", "ALL"]).annotate({ "description": "If provided, you'll get filtered result including reports with provided invoicing state." })), "projects": Schema.optionalKey(ContainsArchivedFilterV1), "rounding": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether the report filter is rounding" })), "sortOrder": Schema.optionalKey(Schema.Literals(["ASCENDING", "DESCENDING"]).annotate({ "description": "If provided, you'll get sorted result by provided sort order." })), "summaryFilter": Schema.optionalKey(SummaryFilterV1), "tags": Schema.optionalKey(ContainsTagFilterV1), "tasks": Schema.optionalKey(ContainsTaskFilterV1), "timeFormat": Schema.optionalKey(Schema.String.annotate({ "description": "Provide time in format THH:MM:SS.ssssss" })), "timeZone": Schema.optionalKey(Schema.String.annotate({ "description": "If provided, you'll get filtered result including reports with provided time zone." })), "userCustomFields": Schema.optionalKey(Schema.Array(CustomFieldFilterV1).annotate({ "writeOnly": true })), "userGroups": Schema.optionalKey(ContainsUsersFilterV1), "userLocale": Schema.optionalKey(Schema.String.annotate({ "description": "If provided, you'll get filtered result including reports with provided user locale." })), "users": Schema.optionalKey(ContainsUsersFilterV1), "weekStart": Schema.optionalKey(Schema.Literals(["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"]).annotate({ "description": "If provided, you'll get filtered result including reports with provided week start." })), "weeklyFilter": Schema.optionalKey(WeeklyFilterV1), "withoutDescription": Schema.optionalKey(Schema.Boolean.annotate({ "description": "If set to 'true', report will only include entries with empty description" })), "zoomLevel": Schema.optionalKey(Schema.Literals(["WEEK", "MONTH", "YEAR"]).annotate({ "description": "If provided, you'll get filtered result including reports with provided zoom level." })) })
export type ReportFilterV1 = { readonly "amountShown"?: "EARNED" | "COST" | "PROFIT" | "HIDE_AMOUNT" | "EXPORT", readonly "amounts"?: ReadonlyArray<"EARNED" | "COST" | "PROFIT" | "HIDE_AMOUNT" | "EXPORT">, readonly "approvalState"?: "APPROVED" | "UNAPPROVED" | "ALL", readonly "archived"?: boolean, readonly "attendanceFilter"?: AttendanceFilterV1, readonly "billable"?: boolean, readonly "clients"?: ContainsArchivedFilterV1, readonly "currency"?: ContainsArchivedFilterV1, readonly "customFields"?: ReadonlyArray<CustomFieldFilterV1>, readonly "dateFormat"?: string, readonly "dateRangeEnd": string, readonly "dateRangeStart": string, readonly "dateRangeType"?: "ABSOLUTE" | "TODAY" | "YESTERDAY" | "THIS_WEEK" | "LAST_WEEK" | "PAST_TWO_WEEKS" | "THIS_MONTH" | "LAST_MONTH" | "THIS_YEAR" | "LAST_YEAR", readonly "description"?: string, readonly "detailedFilter"?: DetailedFilterV1, readonly "exportType"?: "JSON" | "JSON_V1" | "PDF" | "CSV" | "XLSX" | "ZIP", readonly "invoicingState"?: "INVOICED" | "UNINVOICED" | "ALL", readonly "projects"?: ContainsArchivedFilterV1, readonly "rounding"?: boolean, readonly "sortOrder"?: "ASCENDING" | "DESCENDING", readonly "summaryFilter"?: SummaryFilterV1, readonly "tags"?: ContainsTagFilterV1, readonly "tasks"?: ContainsTaskFilterV1, readonly "timeFormat"?: string, readonly "timeZone"?: string, readonly "userCustomFields"?: ReadonlyArray<CustomFieldFilterV1>, readonly "userGroups"?: ContainsUsersFilterV1, readonly "userLocale"?: string, readonly "users"?: ContainsUsersFilterV1, readonly "weekStart"?: "MONDAY" | "TUESDAY" | "WEDNESDAY" | "THURSDAY" | "FRIDAY" | "SATURDAY" | "SUNDAY", readonly "weeklyFilter"?: WeeklyFilterV1, readonly "withoutDescription"?: boolean, readonly "zoomLevel"?: "WEEK" | "MONTH" | "YEAR" }
export const ReportFilterV1 = Schema.Struct({ "amountShown": Schema.optionalKey(Schema.Literals(["EARNED", "COST", "PROFIT", "HIDE_AMOUNT", "EXPORT"]).annotate({ "description": "If provided, you'll get filtered result including reports with provided amount shown." })), "amounts": Schema.optionalKey(Schema.Array(Schema.Literals(["EARNED", "COST", "PROFIT", "HIDE_AMOUNT", "EXPORT"]))), "approvalState": Schema.optionalKey(Schema.Literals(["APPROVED", "UNAPPROVED", "ALL"]).annotate({ "description": "If provided, you'll get filtered result including reports with provided approval state." })), "archived": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether the report is archived" })), "attendanceFilter": Schema.optionalKey(AttendanceFilterV1), "billable": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether the report is billable" })), "clients": Schema.optionalKey(ContainsArchivedFilterV1), "currency": Schema.optionalKey(ContainsArchivedFilterV1), "customFields": Schema.optionalKey(Schema.Array(CustomFieldFilterV1)), "dateFormat": Schema.optionalKey(Schema.String.annotate({ "description": "Provide date in format YYYY-MM-DD" })), "dateRangeEnd": Schema.String.annotate({ "description": "Provide date in format YYYY-MM-DDTHH:MM:SS.ssssss. The system interprets this value based on the user's timezone (provided in the timeZone request parameter or the timezone configured in the user profile)" }).check(Schema.isMinLength(1)), "dateRangeStart": Schema.String.annotate({ "description": "Provide date in format YYYY-MM-DDTHH:MM:SS.ssssss. The system interprets this value based on the user's timezone (provided in the timeZone request parameter or the timezone configured in the user profile)" }).check(Schema.isMinLength(1)), "dateRangeType": Schema.optionalKey(Schema.Literals(["ABSOLUTE", "TODAY", "YESTERDAY", "THIS_WEEK", "LAST_WEEK", "PAST_TWO_WEEKS", "THIS_MONTH", "LAST_MONTH", "THIS_YEAR", "LAST_YEAR"]).annotate({ "description": "Provide the date range type" })), "description": Schema.optionalKey(Schema.String.annotate({ "description": "Represents search term for filtering report entries by description" })), "detailedFilter": Schema.optionalKey(DetailedFilterV1), "exportType": Schema.optionalKey(Schema.Literals(["JSON", "JSON_V1", "PDF", "CSV", "XLSX", "ZIP"]).annotate({ "description": "If provided, you'll get filtered result including reports with provided export type." })), "invoicingState": Schema.optionalKey(Schema.Literals(["INVOICED", "UNINVOICED", "ALL"]).annotate({ "description": "If provided, you'll get filtered result including reports with provided invoicing state." })), "projects": Schema.optionalKey(ContainsArchivedFilterV1), "rounding": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether the report filter is rounding" })), "sortOrder": Schema.optionalKey(Schema.Literals(["ASCENDING", "DESCENDING"]).annotate({ "description": "If provided, you'll get sorted result by provided sort order." })), "summaryFilter": Schema.optionalKey(SummaryFilterV1), "tags": Schema.optionalKey(ContainsTagFilterV1), "tasks": Schema.optionalKey(ContainsTaskFilterV1), "timeFormat": Schema.optionalKey(Schema.String.annotate({ "description": "Provide time in format THH:MM:SS.ssssss" })), "timeZone": Schema.optionalKey(Schema.String.annotate({ "description": "If provided, you'll get filtered result including reports with provided time zone." })), "userCustomFields": Schema.optionalKey(Schema.Array(CustomFieldFilterV1).annotate({ "writeOnly": true })), "userGroups": Schema.optionalKey(ContainsUsersFilterV1), "userLocale": Schema.optionalKey(Schema.String.annotate({ "description": "If provided, you'll get filtered result including reports with provided user locale." })), "users": Schema.optionalKey(ContainsUsersFilterV1), "weekStart": Schema.optionalKey(Schema.Literals(["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"]).annotate({ "description": "If provided, you'll get filtered result including reports with provided week start." })), "weeklyFilter": Schema.optionalKey(WeeklyFilterV1), "withoutDescription": Schema.optionalKey(Schema.Boolean.annotate({ "description": "If set to 'true', report will only include entries with empty description" })), "zoomLevel": Schema.optionalKey(Schema.Literals(["WEEK", "MONTH", "YEAR"]).annotate({ "description": "If provided, you'll get filtered result including reports with provided zoom level." })) })
export type SummaryReportFilterV1 = { readonly "amountShown"?: "EARNED" | "COST" | "PROFIT" | "HIDE_AMOUNT" | "EXPORT", readonly "amounts"?: ReadonlyArray<"EARNED" | "COST" | "PROFIT" | "HIDE_AMOUNT" | "EXPORT">, readonly "approvalState"?: "APPROVED" | "UNAPPROVED" | "ALL", readonly "archived"?: boolean, readonly "attendanceFilter"?: AttendanceFilterV1, readonly "billable"?: boolean, readonly "clients"?: ContainsArchivedFilterV1, readonly "currency"?: ContainsArchivedFilterV1, readonly "customFields"?: ReadonlyArray<CustomFieldFilterV1>, readonly "dateFormat"?: string, readonly "dateRangeEnd": string, readonly "dateRangeStart": string, readonly "dateRangeType"?: "ABSOLUTE" | "TODAY" | "YESTERDAY" | "THIS_WEEK" | "LAST_WEEK" | "PAST_TWO_WEEKS" | "THIS_MONTH" | "LAST_MONTH" | "THIS_YEAR" | "LAST_YEAR", readonly "description"?: string, readonly "detailedFilter"?: DetailedFilterV1, readonly "exportType"?: "JSON" | "JSON_V1" | "PDF" | "CSV" | "XLSX" | "ZIP", readonly "invoicingState"?: "INVOICED" | "UNINVOICED" | "ALL", readonly "projects"?: ContainsArchivedFilterV1, readonly "rounding"?: boolean, readonly "sortOrder"?: "ASCENDING" | "DESCENDING", readonly "summaryFilter": SummaryFilterV1, readonly "tags"?: ContainsTagFilterV1, readonly "tasks"?: ContainsTaskFilterV1, readonly "timeFormat"?: string, readonly "timeZone"?: string, readonly "userCustomFields"?: ReadonlyArray<CustomFieldFilterV1>, readonly "userGroups"?: ContainsUsersFilterV1, readonly "userLocale"?: string, readonly "users"?: ContainsUsersFilterV1, readonly "weekStart"?: "MONDAY" | "TUESDAY" | "WEDNESDAY" | "THURSDAY" | "FRIDAY" | "SATURDAY" | "SUNDAY", readonly "weeklyFilter"?: WeeklyFilterV1, readonly "withoutDescription"?: boolean, readonly "zoomLevel"?: "WEEK" | "MONTH" | "YEAR" }
export const SummaryReportFilterV1 = Schema.Struct({ "amountShown": Schema.optionalKey(Schema.Literals(["EARNED", "COST", "PROFIT", "HIDE_AMOUNT", "EXPORT"]).annotate({ "description": "If provided, you'll get filtered result including reports with provided amount shown." })), "amounts": Schema.optionalKey(Schema.Array(Schema.Literals(["EARNED", "COST", "PROFIT", "HIDE_AMOUNT", "EXPORT"]))), "approvalState": Schema.optionalKey(Schema.Literals(["APPROVED", "UNAPPROVED", "ALL"]).annotate({ "description": "If provided, you'll get filtered result including reports with provided approval state." })), "archived": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether the report is archived" })), "attendanceFilter": Schema.optionalKey(AttendanceFilterV1), "billable": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether the report is billable" })), "clients": Schema.optionalKey(ContainsArchivedFilterV1), "currency": Schema.optionalKey(ContainsArchivedFilterV1), "customFields": Schema.optionalKey(Schema.Array(CustomFieldFilterV1)), "dateFormat": Schema.optionalKey(Schema.String.annotate({ "description": "Provide date in format YYYY-MM-DD" })), "dateRangeEnd": Schema.String.annotate({ "description": "Provide date in format YYYY-MM-DDTHH:MM:SS.ssssss. The system interprets this value based on the user's timezone (provided in the timeZone request parameter or the timezone configured in the user profile)" }).check(Schema.isMinLength(1)), "dateRangeStart": Schema.String.annotate({ "description": "Provide date in format YYYY-MM-DDTHH:MM:SS.ssssss. The system interprets this value based on the user's timezone (provided in the timeZone request parameter or the timezone configured in the user profile)" }).check(Schema.isMinLength(1)), "dateRangeType": Schema.optionalKey(Schema.Literals(["ABSOLUTE", "TODAY", "YESTERDAY", "THIS_WEEK", "LAST_WEEK", "PAST_TWO_WEEKS", "THIS_MONTH", "LAST_MONTH", "THIS_YEAR", "LAST_YEAR"]).annotate({ "description": "Provide the date range type" })), "description": Schema.optionalKey(Schema.String.annotate({ "description": "Represents search term for filtering report entries by description" })), "detailedFilter": Schema.optionalKey(DetailedFilterV1), "exportType": Schema.optionalKey(Schema.Literals(["JSON", "JSON_V1", "PDF", "CSV", "XLSX", "ZIP"]).annotate({ "description": "If provided, you'll get filtered result including reports with provided export type." })), "invoicingState": Schema.optionalKey(Schema.Literals(["INVOICED", "UNINVOICED", "ALL"]).annotate({ "description": "If provided, you'll get filtered result including reports with provided invoicing state." })), "projects": Schema.optionalKey(ContainsArchivedFilterV1), "rounding": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether the report filter is rounding" })), "sortOrder": Schema.optionalKey(Schema.Literals(["ASCENDING", "DESCENDING"]).annotate({ "description": "If provided, you'll get sorted result by provided sort order." })), "summaryFilter": SummaryFilterV1, "tags": Schema.optionalKey(ContainsTagFilterV1), "tasks": Schema.optionalKey(ContainsTaskFilterV1), "timeFormat": Schema.optionalKey(Schema.String.annotate({ "description": "Provide time in format THH:MM:SS.ssssss" })), "timeZone": Schema.optionalKey(Schema.String.annotate({ "description": "If provided, you'll get filtered result including reports with provided time zone." })), "userCustomFields": Schema.optionalKey(Schema.Array(CustomFieldFilterV1).annotate({ "writeOnly": true })), "userGroups": Schema.optionalKey(ContainsUsersFilterV1), "userLocale": Schema.optionalKey(Schema.String.annotate({ "description": "If provided, you'll get filtered result including reports with provided user locale." })), "users": Schema.optionalKey(ContainsUsersFilterV1), "weekStart": Schema.optionalKey(Schema.Literals(["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"]).annotate({ "description": "If provided, you'll get filtered result including reports with provided week start." })), "weeklyFilter": Schema.optionalKey(WeeklyFilterV1), "withoutDescription": Schema.optionalKey(Schema.Boolean.annotate({ "description": "If set to 'true', report will only include entries with empty description" })), "zoomLevel": Schema.optionalKey(Schema.Literals(["WEEK", "MONTH", "YEAR"]).annotate({ "description": "If provided, you'll get filtered result including reports with provided zoom level." })) })
export type WeeklyReportFilterV1 = { readonly "amountShown"?: "EARNED" | "COST" | "PROFIT" | "HIDE_AMOUNT" | "EXPORT", readonly "amounts"?: ReadonlyArray<"EARNED" | "COST" | "PROFIT" | "HIDE_AMOUNT" | "EXPORT">, readonly "approvalState"?: "APPROVED" | "UNAPPROVED" | "ALL", readonly "archived"?: boolean, readonly "attendanceFilter"?: AttendanceFilterV1, readonly "billable"?: boolean, readonly "clients"?: ContainsArchivedFilterV1, readonly "currency"?: ContainsArchivedFilterV1, readonly "customFields"?: ReadonlyArray<CustomFieldFilterV1>, readonly "dateFormat"?: string, readonly "dateRangeEnd": string, readonly "dateRangeStart": string, readonly "dateRangeType"?: "ABSOLUTE" | "TODAY" | "YESTERDAY" | "THIS_WEEK" | "LAST_WEEK" | "PAST_TWO_WEEKS" | "THIS_MONTH" | "LAST_MONTH" | "THIS_YEAR" | "LAST_YEAR", readonly "description"?: string, readonly "detailedFilter"?: DetailedFilterV1, readonly "exportType"?: "JSON" | "JSON_V1" | "PDF" | "CSV" | "XLSX" | "ZIP", readonly "invoicingState"?: "INVOICED" | "UNINVOICED" | "ALL", readonly "projects"?: ContainsArchivedFilterV1, readonly "rounding"?: boolean, readonly "sortOrder"?: "ASCENDING" | "DESCENDING", readonly "summaryFilter"?: SummaryFilterV1, readonly "tags"?: ContainsTagFilterV1, readonly "tasks"?: ContainsTaskFilterV1, readonly "timeFormat"?: string, readonly "timeZone"?: string, readonly "userCustomFields"?: ReadonlyArray<CustomFieldFilterV1>, readonly "userGroups"?: ContainsUsersFilterV1, readonly "userLocale"?: string, readonly "users"?: ContainsUsersFilterV1, readonly "weekStart"?: "MONDAY" | "TUESDAY" | "WEDNESDAY" | "THURSDAY" | "FRIDAY" | "SATURDAY" | "SUNDAY", readonly "weeklyFilter": WeeklyFilterV1, readonly "withoutDescription"?: boolean, readonly "zoomLevel"?: "WEEK" | "MONTH" | "YEAR" }
export const WeeklyReportFilterV1 = Schema.Struct({ "amountShown": Schema.optionalKey(Schema.Literals(["EARNED", "COST", "PROFIT", "HIDE_AMOUNT", "EXPORT"]).annotate({ "description": "If provided, you'll get filtered result including reports with provided amount shown." })), "amounts": Schema.optionalKey(Schema.Array(Schema.Literals(["EARNED", "COST", "PROFIT", "HIDE_AMOUNT", "EXPORT"]))), "approvalState": Schema.optionalKey(Schema.Literals(["APPROVED", "UNAPPROVED", "ALL"]).annotate({ "description": "If provided, you'll get filtered result including reports with provided approval state." })), "archived": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether the report is archived" })), "attendanceFilter": Schema.optionalKey(AttendanceFilterV1), "billable": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether the report is billable" })), "clients": Schema.optionalKey(ContainsArchivedFilterV1), "currency": Schema.optionalKey(ContainsArchivedFilterV1), "customFields": Schema.optionalKey(Schema.Array(CustomFieldFilterV1)), "dateFormat": Schema.optionalKey(Schema.String.annotate({ "description": "Provide date in format YYYY-MM-DD" })), "dateRangeEnd": Schema.String.annotate({ "description": "Provide date in format YYYY-MM-DDTHH:MM:SS.ssssss. The system interprets this value based on the user's timezone (provided in the timeZone request parameter or the timezone configured in the user profile)" }).check(Schema.isMinLength(1)), "dateRangeStart": Schema.String.annotate({ "description": "Provide date in format YYYY-MM-DDTHH:MM:SS.ssssss. The system interprets this value based on the user's timezone (provided in the timeZone request parameter or the timezone configured in the user profile)" }).check(Schema.isMinLength(1)), "dateRangeType": Schema.optionalKey(Schema.Literals(["ABSOLUTE", "TODAY", "YESTERDAY", "THIS_WEEK", "LAST_WEEK", "PAST_TWO_WEEKS", "THIS_MONTH", "LAST_MONTH", "THIS_YEAR", "LAST_YEAR"]).annotate({ "description": "Provide the date range type" })), "description": Schema.optionalKey(Schema.String.annotate({ "description": "Represents search term for filtering report entries by description" })), "detailedFilter": Schema.optionalKey(DetailedFilterV1), "exportType": Schema.optionalKey(Schema.Literals(["JSON", "JSON_V1", "PDF", "CSV", "XLSX", "ZIP"]).annotate({ "description": "If provided, you'll get filtered result including reports with provided export type." })), "invoicingState": Schema.optionalKey(Schema.Literals(["INVOICED", "UNINVOICED", "ALL"]).annotate({ "description": "If provided, you'll get filtered result including reports with provided invoicing state." })), "projects": Schema.optionalKey(ContainsArchivedFilterV1), "rounding": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether the report filter is rounding" })), "sortOrder": Schema.optionalKey(Schema.Literals(["ASCENDING", "DESCENDING"]).annotate({ "description": "If provided, you'll get sorted result by provided sort order." })), "summaryFilter": Schema.optionalKey(SummaryFilterV1), "tags": Schema.optionalKey(ContainsTagFilterV1), "tasks": Schema.optionalKey(ContainsTaskFilterV1), "timeFormat": Schema.optionalKey(Schema.String.annotate({ "description": "Provide time in format THH:MM:SS.ssssss" })), "timeZone": Schema.optionalKey(Schema.String.annotate({ "description": "If provided, you'll get filtered result including reports with provided time zone." })), "userCustomFields": Schema.optionalKey(Schema.Array(CustomFieldFilterV1).annotate({ "writeOnly": true })), "userGroups": Schema.optionalKey(ContainsUsersFilterV1), "userLocale": Schema.optionalKey(Schema.String.annotate({ "description": "If provided, you'll get filtered result including reports with provided user locale." })), "users": Schema.optionalKey(ContainsUsersFilterV1), "weekStart": Schema.optionalKey(Schema.Literals(["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"]).annotate({ "description": "If provided, you'll get filtered result including reports with provided week start." })), "weeklyFilter": WeeklyFilterV1, "withoutDescription": Schema.optionalKey(Schema.Boolean.annotate({ "description": "If set to 'true', report will only include entries with empty description" })), "zoomLevel": Schema.optionalKey(Schema.Literals(["WEEK", "MONTH", "YEAR"]).annotate({ "description": "If provided, you'll get filtered result including reports with provided zoom level." })) })
export type ExpenseDetailedReportDtoV1 = { readonly "expenses"?: ReadonlyArray<ExpenseReportDtoV1>, readonly "totals"?: ExpenseTotalsDtoV1 }
export const ExpenseDetailedReportDtoV1 = Schema.Struct({ "expenses": Schema.optionalKey(Schema.Array(ExpenseReportDtoV1).annotate({ "description": "Represents list of expenses" })), "totals": Schema.optionalKey(ExpenseTotalsDtoV1) }).annotate({ "description": "report" })
export type MemberProfileDtoV1 = { readonly "email"?: string, readonly "hasPassword"?: boolean, readonly "hasPendingApprovalRequest"?: boolean, readonly "imageUrl"?: string, readonly "name"?: string, readonly "userCustomFieldValues"?: ReadonlyArray<UserCustomFieldValueFullDtoV1>, readonly "weekStart"?: "MONDAY" | "TUESDAY" | "WEDNESDAY" | "THURSDAY" | "FRIDAY" | "SATURDAY" | "SUNDAY", readonly "workCapacity"?: string, readonly "workingDays"?: "MONDAY" | "TUESDAY" | "WEDNESDAY" | "THURSDAY" | "FRIDAY" | "SATURDAY" | "SUNDAY", readonly "workspaceNumber"?: number }
export const MemberProfileDtoV1 = Schema.Struct({ "email": Schema.optionalKey(Schema.String.annotate({ "description": "Represents email address of the user." })), "hasPassword": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether user has password or none." })), "hasPendingApprovalRequest": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether user has pending approval request." })), "imageUrl": Schema.optionalKey(Schema.String.annotate({ "description": "Represents an image url." })), "name": Schema.optionalKey(Schema.String.annotate({ "description": "Represents name of the user." })), "userCustomFieldValues": Schema.optionalKey(Schema.Array(UserCustomFieldValueFullDtoV1).annotate({ "description": "Represents a list of value objects for user’s custom fields." })), "weekStart": Schema.optionalKey(Schema.Literals(["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"]).annotate({ "description": "Represents a day of the week." })), "workCapacity": Schema.optionalKey(Schema.String.annotate({ "description": "Represents work capacity as a time duration in the ISO-8601 format." })), "workingDays": Schema.optionalKey(Schema.Literals(["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"]).annotate({ "description": "Represents a list of days of the week." })), "workspaceNumber": Schema.optionalKey(Schema.Number.annotate({ "description": "Represents the number of workspace(s) the user is associated to.", "format": "int32" }).check(Schema.isInt())) })
export type WorkspaceDtoV1 = { readonly "cakeOrganizationId"?: string, readonly "costRate"?: RateDtoV1, readonly "currencies"?: ReadonlyArray<CurrencyWithDefaultInfoDtoV1>, readonly "featureSubscriptionType"?: FeaturePlan, readonly "features"?: Feature, readonly "hourlyRate"?: HourlyRateDtoV1, readonly "id": string, readonly "imageUrl"?: string, readonly "memberships"?: ReadonlyArray<MembershipDtoV1>, readonly "name": string, readonly "subdomain"?: WorkspaceSubdomainDtoV1, readonly "workspaceSettings"?: WorkspaceSettingsDtoV1 }
export const WorkspaceDtoV1 = Schema.Struct({ "cakeOrganizationId": Schema.optionalKey(Schema.String.annotate({ "description": "Represents the Cake organization identifier across the system." })), "costRate": Schema.optionalKey(RateDtoV1), "currencies": Schema.optionalKey(Schema.Array(CurrencyWithDefaultInfoDtoV1).annotate({ "description": "Represents currency with default info object." })), "featureSubscriptionType": Schema.optionalKey(FeaturePlan), "features": Schema.optionalKey(Feature), "hourlyRate": Schema.optionalKey(HourlyRateDtoV1), "id": Schema.String.annotate({ "description": "Represents workspace identifier across the system." }), "imageUrl": Schema.optionalKey(Schema.String.annotate({ "description": "Represents an image url." })), "memberships": Schema.optionalKey(Schema.Array(MembershipDtoV1).annotate({ "description": "Represents a list of membership objects." })), "name": Schema.String.annotate({ "description": "Represents workspace name." }), "subdomain": Schema.optionalKey(WorkspaceSubdomainDtoV1), "workspaceSettings": Schema.optionalKey(WorkspaceSettingsDtoV1) })
export type TimeOffRequestsWithCountV1Dto = { readonly "count"?: number, readonly "requests"?: ReadonlyArray<TimeOffRequestFullV1Dto> }
export const TimeOffRequestsWithCountV1Dto = Schema.Struct({ "count": Schema.optionalKey(Schema.Number.annotate({ "description": "Total count of time off requests.", "format": "int32" }).check(Schema.isInt())), "requests": Schema.optionalKey(Schema.Array(TimeOffRequestFullV1Dto)) })
export type ExpensesAndTotalsDtoV1 = { readonly "dailyTotals"?: ReadonlyArray<ExpenseDailyTotalsDtoV1>, readonly "expenses"?: ExpensesWithCountDtoV1, readonly "weeklyTotals"?: ReadonlyArray<ExpenseWeeklyTotalsDtoV1> }
export const ExpensesAndTotalsDtoV1 = Schema.Struct({ "dailyTotals": Schema.optionalKey(Schema.Array(ExpenseDailyTotalsDtoV1).annotate({ "description": "Represents a list of expense daily total data transfer objects." })), "expenses": Schema.optionalKey(ExpensesWithCountDtoV1), "weeklyTotals": Schema.optionalKey(Schema.Array(ExpenseWeeklyTotalsDtoV1).annotate({ "description": "Represents a list of expense weekly total data transfer objects." })) })
export type SharedReportRequestV1 = { readonly "filter"?: ReportFilterV1, readonly "fixedDate"?: boolean, readonly "isPublic"?: boolean, readonly "name"?: string, readonly "type"?: "DETAILED" | "WEEKLY" | "SUMMARY" | "SCHEDULED" | "EXPENSE_DETAILED" | "EXPENSE_RECEIPT" | "PTO_REQUESTS" | "PTO_BALANCE" | "ATTENDANCE" | "INVOICE_EXPENSE" | "INVOICE_TIME" | "PROJECT" | "TEAM_FULL" | "TEAM_LIMITED" | "TEAM_GROUPS" | "INVOICES" | "KIOSK_PIN_LIST" | "KIOSK_ASSIGNEES" | "USER_DATA_EXPORT", readonly "visibleToUserGroups"?: ReadonlyArray<string>, readonly "visibleToUsers"?: ReadonlyArray<string> }
export const SharedReportRequestV1 = Schema.Struct({ "filter": Schema.optionalKey(ReportFilterV1), "fixedDate": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether the shared report has a fixed date range." })), "isPublic": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Indicates whether the shared report is public or not" })), "name": Schema.optionalKey(Schema.String.annotate({ "description": "Represents a shared report's name" })), "type": Schema.optionalKey(Schema.Literals(["DETAILED", "WEEKLY", "SUMMARY", "SCHEDULED", "EXPENSE_DETAILED", "EXPENSE_RECEIPT", "PTO_REQUESTS", "PTO_BALANCE", "ATTENDANCE", "INVOICE_EXPENSE", "INVOICE_TIME", "PROJECT", "TEAM_FULL", "TEAM_LIMITED", "TEAM_GROUPS", "INVOICES", "KIOSK_PIN_LIST", "KIOSK_ASSIGNEES", "USER_DATA_EXPORT"]).annotate({ "description": "Represent the type of shared report." })), "visibleToUserGroups": Schema.optionalKey(Schema.Array(Schema.String.annotate({ "description": "Represents user group ids." })).annotate({ "description": "Represents user group ids." }).check(Schema.isUnique())), "visibleToUsers": Schema.optionalKey(Schema.Array(Schema.String.annotate({ "description": "Represents user ids." })).annotate({ "description": "Represents user ids." }).check(Schema.isUnique())) })
// recursive definitions
export type GroupOneDto = { readonly "amount"?: number, readonly "children"?: ReadonlyArray<GroupOneDto>, readonly "clientName"?: string, readonly "days"?: ReadonlyArray<DailyTotalDto>, readonly "duration"?: number, readonly "id"?: string, readonly "name"?: string, readonly "nameLowerCase"?: string }
export const GroupOneDto = Schema.Struct({ "amount": Schema.optionalKey(Schema.Number.annotate({ "description": "Represents group one amount" }).check(Schema.isFinite())), "children": Schema.optionalKey(Schema.Array(Schema.suspend((): Schema.Codec<GroupOneDto> => GroupOneDto)).annotate({ "description": "Represents list of children groups" })), "clientName": Schema.optionalKey(Schema.String.annotate({ "description": "Represents client name" })), "days": Schema.optionalKey(Schema.Array(DailyTotalDto).annotate({ "description": "Represents list of days" })), "duration": Schema.optionalKey(Schema.Number.annotate({ "description": "Represents duration" }).check(Schema.isFinite())), "id": Schema.optionalKey(Schema.String.annotate({ "description": "Represents group one identifier across the system." })), "name": Schema.optionalKey(Schema.String.annotate({ "description": "Represents name" })), "nameLowerCase": Schema.optionalKey(Schema.String.annotate({ "description": "Represents lower case name" })) }).annotate({ "description": "List of groups" })
// schemas
export type UploadImageRequestFormData = { readonly "file": string }
export const UploadImageRequestFormData = Schema.Struct({ "file": Schema.String.annotate({ "description": "Image to be uploaded", "format": "binary" }) })
export type UploadImage200 = UploadFileResponseV1
export const UploadImage200 = UploadFileResponseV1
export type GetLoggedUserParams = { readonly "include-memberships"?: boolean }
export const GetLoggedUserParams = Schema.Struct({ "include-memberships": Schema.optionalKey(Schema.Boolean.annotate({ "description": "If set to true, memberships will be included." })) })
export type GetLoggedUser200 = UserDtoV1
export const GetLoggedUser200 = UserDtoV1
export type GetWorkspacesOfUserParams = { readonly "roles"?: "WORKSPACE_ADMIN" | "OWNER" | "TEAM_MANAGER" | "PROJECT_MANAGER" }
export const GetWorkspacesOfUserParams = Schema.Struct({ "roles": Schema.optionalKey(Schema.Literals(["WORKSPACE_ADMIN", "OWNER", "TEAM_MANAGER", "PROJECT_MANAGER"])) })
export type GetWorkspacesOfUser200 = ReadonlyArray<WorkspaceDtoV1>
export const GetWorkspacesOfUser200 = Schema.Array(WorkspaceDtoV1)
export type CreateWorkspaceRequestJson = CreateWorkspaceRequestV1
export const CreateWorkspaceRequestJson = CreateWorkspaceRequestV1
export type CreateWorkspace201 = WorkspaceDtoV1
export const CreateWorkspace201 = WorkspaceDtoV1
export type GetWorkspaceOfUser200 = WorkspaceDtoV1
export const GetWorkspaceOfUser200 = WorkspaceDtoV1
export type GetAddonWebhooks200 = WebhooksDtoV1
export const GetAddonWebhooks200 = WebhooksDtoV1
export type GetApprovalRequestsParams = { readonly "status"?: "PENDING" | "APPROVED" | "WITHDRAWN_APPROVAL", readonly "sort-column"?: "ID" | "USER_ID" | "START" | "UPDATED_AT", readonly "sort-order"?: "ASCENDING" | "DESCENDING", readonly "page"?: number, readonly "page-size"?: number }
export const GetApprovalRequestsParams = Schema.Struct({ "status": Schema.optionalKey(Schema.Literals(["PENDING", "APPROVED", "WITHDRAWN_APPROVAL"])), "sort-column": Schema.optionalKey(Schema.Literals(["ID", "USER_ID", "START", "UPDATED_AT"])), "sort-order": Schema.optionalKey(Schema.Literals(["ASCENDING", "DESCENDING"])), "page": Schema.optionalKey(Schema.Number.annotate({ "description": "Page number.", "format": "int32" }).check(Schema.isInt())), "page-size": Schema.optionalKey(Schema.Number.annotate({ "description": "Page size.", "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1))) })
export type GetApprovalRequests200 = ReadonlyArray<ApprovalDetailsDtoV1>
export const GetApprovalRequests200 = Schema.Array(ApprovalDetailsDtoV1)
export type CreateApprrovalRequestRequestJson = CreateApprovalRequest
export const CreateApprrovalRequestRequestJson = CreateApprovalRequest
export type CreateApprrovalRequest201 = ApprovalRequestDtoV1
export const CreateApprrovalRequest201 = ApprovalRequestDtoV1
export type ResubmitApprovalRequestRequestJson = CreateApprovalRequest
export const ResubmitApprovalRequestRequestJson = CreateApprovalRequest
export type CreateApprovalForOtherRequestJson = CreateApprovalRequest
export const CreateApprovalForOtherRequestJson = CreateApprovalRequest
export type CreateApprovalForOther201 = ApprovalRequestDtoV1
export const CreateApprovalForOther201 = ApprovalRequestDtoV1
export type ResubmitApprovalRequestForOtherRequestJson = CreateApprovalRequest
export const ResubmitApprovalRequestForOtherRequestJson = CreateApprovalRequest
export type UpdateApprovalStatusRequestJson = UpdateApprovalRequest
export const UpdateApprovalStatusRequestJson = UpdateApprovalRequest
export type UpdateApprovalStatus200 = ApprovalRequestDtoV1
export const UpdateApprovalStatus200 = ApprovalRequestDtoV1
export type GetClientsParams = { readonly "name"?: string, readonly "sort-column"?: string, readonly "sort-order"?: string, readonly "page"?: number, readonly "page-size"?: number, readonly "archived"?: string }
export const GetClientsParams = Schema.Struct({ "name": Schema.optionalKey(Schema.String.annotate({ "description": "Filters client results that matches with the string provided in their client name." })), "sort-column": Schema.optionalKey(Schema.String.annotate({ "description": "Column name that will be used as criteria for sorting results." })), "sort-order": Schema.optionalKey(Schema.String), "page": Schema.optionalKey(Schema.Number.annotate({ "description": "Page number.", "format": "int32" }).check(Schema.isInt())), "page-size": Schema.optionalKey(Schema.Number.annotate({ "description": "Page size.", "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1))), "archived": Schema.optionalKey(Schema.String) })
export type GetClients200 = ReadonlyArray<ClientWithCurrencyDtoV1>
export const GetClients200 = Schema.Array(ClientWithCurrencyDtoV1)
export type CreateClientRequestJson = CreateClientRequestV1
export const CreateClientRequestJson = CreateClientRequestV1
export type CreateClient201 = ClientWithCurrencyDtoV1
export const CreateClient201 = ClientWithCurrencyDtoV1
export type GetClient200 = ClientWithCurrencyDtoV1
export const GetClient200 = ClientWithCurrencyDtoV1
export type UpdateClientParams = { readonly "archive-projects"?: boolean, readonly "mark-tasks-as-done"?: boolean }
export const UpdateClientParams = Schema.Struct({ "archive-projects": Schema.optionalKey(Schema.Boolean), "mark-tasks-as-done": Schema.optionalKey(Schema.Boolean) })
export type UpdateClientRequestJson = UpdateClientRequestV1
export const UpdateClientRequestJson = UpdateClientRequestV1
export type UpdateClient200 = ClientDtoV1
export const UpdateClient200 = ClientDtoV1
export type DeleteClient200 = ClientDtoV1
export const DeleteClient200 = ClientDtoV1
export type SetWorkspaceCostRateRequestJson = CostRateRequestV1
export const SetWorkspaceCostRateRequestJson = CostRateRequestV1
export type SetWorkspaceCostRate200 = WorkspaceDtoV1
export const SetWorkspaceCostRate200 = WorkspaceDtoV1
export type OfWorkspaceParams = { readonly "name"?: string, readonly "status"?: "INACTIVE" | "VISIBLE" | "INVISIBLE", readonly "entity-type"?: string }
export const OfWorkspaceParams = Schema.Struct({ "name": Schema.optionalKey(Schema.String.annotate({ "description": "If provided, you'll get a filtered list of custom fields that contain the provided string in their name." })), "status": Schema.optionalKey(Schema.Literals(["INACTIVE", "VISIBLE", "INVISIBLE"])), "entity-type": Schema.optionalKey(Schema.String) })
export type OfWorkspace200 = ReadonlyArray<CustomFieldDtoV1>
export const OfWorkspace200 = Schema.Array(CustomFieldDtoV1)
export type CreateRequestJson = CustomFieldRequestV1
export const CreateRequestJson = CustomFieldRequestV1
export type EditCustomFieldRequestJson = UpdateCustomFieldRequestV1
export const EditCustomFieldRequestJson = UpdateCustomFieldRequestV1
export type EditCustomField200 = CustomFieldDtoV1
export const EditCustomField200 = CustomFieldDtoV1
export type GetCreatedEntityInfoParams = { readonly "type": ReadonlyArray<string>, readonly "start"?: string, readonly "end"?: string, readonly "page"?: string, readonly "limit"?: string }
export const GetCreatedEntityInfoParams = Schema.Struct({ "type": Schema.Array(Schema.String.annotate({ "description": "Specifies the type of document to be retrieved. Expected values are ${changetracker.update.documentation.description}.This parameter can accept multiple values, and at least one option must be provided. Based on the input, the application will return results corresponding to the selected document types." })).annotate({ "description": "Specifies the type of document to be retrieved. Expected values are ${changetracker.update.documentation.description}.This parameter can accept multiple values, and at least one option must be provided. Based on the input, the application will return results corresponding to the selected document types." }), "start": Schema.optionalKey(Schema.String.annotate({ "description": "Represents the start date in yyyy-MM-ddThh:mm:ssZ format. This parameter is optional; if no start date is provided, the application will set a default start date that matches the end date to create a date range of 30 days. If the end date is not specified either, the default behavior will apply from the current date." })), "end": Schema.optionalKey(Schema.String.annotate({ "description": "Represents the end date in yyyy-MM-ddThh:mm:ssZ format. This parameter is optional; if no end date is provided, the application will set a default end date that matches the start date to create a date range of 30 days." })), "page": Schema.optionalKey(Schema.String), "limit": Schema.optionalKey(Schema.String) })
export type GetCreatedEntityInfo200 = string
export const GetCreatedEntityInfo200 = Schema.String
export type GetDeletedEntityInfoParams = { readonly "type": ReadonlyArray<string>, readonly "start"?: string, readonly "end"?: string, readonly "page"?: string, readonly "limit"?: string }
export const GetDeletedEntityInfoParams = Schema.Struct({ "type": Schema.Array(Schema.String.annotate({ "description": "Specifies the type of document to be retrieved. Expected values are ${changetracker.update.documentation.description}.This parameter can accept multiple values, and at least one option must be provided. Based on the input, the application will return results corresponding to the selected document types." })).annotate({ "description": "Specifies the type of document to be retrieved. Expected values are ${changetracker.update.documentation.description}.This parameter can accept multiple values, and at least one option must be provided. Based on the input, the application will return results corresponding to the selected document types." }), "start": Schema.optionalKey(Schema.String.annotate({ "description": "Represents the start date in yyyy-MM-ddThh:mm:ssZ format. This parameter is optional; if no start date is provided, the application will set a default start date that matches the end date to create a date range of 30 days. If the end date is not specified either, the default behavior will apply from the current date." })), "end": Schema.optionalKey(Schema.String.annotate({ "description": "Represents the end date in yyyy-MM-ddThh:mm:ssZ format. This parameter is optional; if no end date is provided, the application will set a default end date that matches the start date to create a date range of 30 days." })), "page": Schema.optionalKey(Schema.String), "limit": Schema.optionalKey(Schema.String) })
export type GetDeletedEntityInfo200 = PageableCollectionLogBinDocumentDto
export const GetDeletedEntityInfo200 = PageableCollectionLogBinDocumentDto
export type GetUpdatedEntityInfoParams = { readonly "type": ReadonlyArray<string>, readonly "start"?: string, readonly "end"?: string, readonly "page"?: string, readonly "limit"?: string }
export const GetUpdatedEntityInfoParams = Schema.Struct({ "type": Schema.Array(Schema.String.annotate({ "description": "Specifies the type of document to be retrieved. Expected values are ${changetracker.update.documentation.description}.This parameter can accept multiple values, and at least one option must be provided. Based on the input, the application will return results corresponding to the selected document types." })).annotate({ "description": "Specifies the type of document to be retrieved. Expected values are ${changetracker.update.documentation.description}.This parameter can accept multiple values, and at least one option must be provided. Based on the input, the application will return results corresponding to the selected document types." }), "start": Schema.optionalKey(Schema.String.annotate({ "description": "Represents the start date in yyyy-MM-ddThh:mm:ssZ format. This parameter is optional; if no start date is provided, the application will set a default start date that matches the end date to create a date range of 30 days. If the end date is not specified either, the default behavior will apply from the current date." })), "end": Schema.optionalKey(Schema.String.annotate({ "description": "Represents the end date in yyyy-MM-ddThh:mm:ssZ format. This parameter is optional; if no end date is provided, the application will set a default end date that matches the start date to create a date range of 30 days." })), "page": Schema.optionalKey(Schema.String), "limit": Schema.optionalKey(Schema.String) })
export type GetUpdatedEntityInfo200 = string
export const GetUpdatedEntityInfo200 = Schema.String
export type GetExpensesParams = { readonly "page"?: number, readonly "page-size"?: number, readonly "user-id"?: string }
export const GetExpensesParams = Schema.Struct({ "page": Schema.optionalKey(Schema.Number.annotate({ "description": "Page number.", "format": "int32" }).check(Schema.isInt())), "page-size": Schema.optionalKey(Schema.Number.annotate({ "description": "Page size.", "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1))), "user-id": Schema.optionalKey(Schema.String) })
export type GetExpenses200 = ExpensesAndTotalsDtoV1
export const GetExpenses200 = ExpensesAndTotalsDtoV1
export type CreateExpenseRequestFormData = CreateExpenseV1Request
export const CreateExpenseRequestFormData = CreateExpenseV1Request
export type CreateExpense201 = ExpenseDtoV1
export const CreateExpense201 = ExpenseDtoV1
export type GetCategoriesParams = { readonly "sort-column"?: "NAME", readonly "sort-order"?: "ASCENDING" | "DESCENDING", readonly "page"?: number, readonly "page-size"?: number, readonly "archived"?: boolean, readonly "name"?: string }
export const GetCategoriesParams = Schema.Struct({ "sort-column": Schema.optionalKey(Schema.Literal("NAME")), "sort-order": Schema.optionalKey(Schema.Literals(["ASCENDING", "DESCENDING"])), "page": Schema.optionalKey(Schema.Number.annotate({ "description": "Page number.", "format": "int32" }).check(Schema.isInt())), "page-size": Schema.optionalKey(Schema.Number.annotate({ "description": "Page size.", "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1))), "archived": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Flag to filter results based on whether category is archived or not." })), "name": Schema.optionalKey(Schema.String.annotate({ "description": "If provided, you'll get a filtered list of expense categories that matches the provided string in their name." })) })
export type GetCategories200 = ExpenseCategoriesWithCountDtoV1
export const GetCategories200 = ExpenseCategoriesWithCountDtoV1
export type CreateExpenseCategoryRequestJson = ExpenseCategoryV1Request
export const CreateExpenseCategoryRequestJson = ExpenseCategoryV1Request
export type CreateExpenseCategory201 = ExpenseCategoryDtoV1
export const CreateExpenseCategory201 = ExpenseCategoryDtoV1
export type UpdateCategoryRequestJson = ExpenseCategoryV1Request
export const UpdateCategoryRequestJson = ExpenseCategoryV1Request
export type UpdateCategory200 = ExpenseCategoryDtoV1
export const UpdateCategory200 = ExpenseCategoryDtoV1
export type UpdateExpenseCategoryStatusRequestJson = ExpenseCategoryArchiveV1Request
export const UpdateExpenseCategoryStatusRequestJson = ExpenseCategoryArchiveV1Request
export type UpdateExpenseCategoryStatus200 = ExpenseCategoryDtoV1
export const UpdateExpenseCategoryStatus200 = ExpenseCategoryDtoV1
export type GetExpense200 = ExpenseDtoV1
export const GetExpense200 = ExpenseDtoV1
export type UpdateExpenseRequestFormData = UpdateExpenseV1Request
export const UpdateExpenseRequestFormData = UpdateExpenseV1Request
export type UpdateExpense200 = ExpenseDtoV1
export const UpdateExpense200 = ExpenseDtoV1
export type GetHolidaysParams = { readonly "assigned-to"?: string }
export const GetHolidaysParams = Schema.Struct({ "assigned-to": Schema.optionalKey(Schema.String.annotate({ "description": "If provided, you'll get a filtered list of holidays assigned to user." })) })
export type GetHolidays200 = ReadonlyArray<HolidayDtoV1>
export const GetHolidays200 = Schema.Array(HolidayDtoV1)
export type CreateHolidayRequestJson = CreateHolidayRequestV1
export const CreateHolidayRequestJson = CreateHolidayRequestV1
export type CreateHoliday200 = HolidayDtoV1
export const CreateHoliday200 = HolidayDtoV1
export type GetHolidaysInPeriodParams = { readonly "assigned-to": string, readonly "start": string, readonly "end": string }
export const GetHolidaysInPeriodParams = Schema.Struct({ "assigned-to": Schema.String.annotate({ "description": "Filter list of holidays assigned to user." }), "start": Schema.String.annotate({ "description": "Filter list of holidays starting from start date. Expected date format yyyy-MM-ddThh:mm:ssZ" }), "end": Schema.String.annotate({ "description": "Filter list of holidays ending by end date. Expected date format yyyy-MM-ddThh:mm:ssZ" }) })
export type GetHolidaysInPeriod200 = ReadonlyArray<HolidayDtoV1>
export const GetHolidaysInPeriod200 = Schema.Array(HolidayDtoV1)
export type UpdateHolidayRequestJson = UpdateHolidayRequestV1
export const UpdateHolidayRequestJson = UpdateHolidayRequestV1
export type UpdateHoliday200 = HolidayDtoV1
export const UpdateHoliday200 = HolidayDtoV1
export type DeleteHoliday200 = HolidayDto
export const DeleteHoliday200 = HolidayDto
export type SetWorkspaceHourlyRateRequestJson = RateWithCurrencyRequestV1
export const SetWorkspaceHourlyRateRequestJson = RateWithCurrencyRequestV1
export type SetWorkspaceHourlyRate200 = WorkspaceDtoV1
export const SetWorkspaceHourlyRate200 = WorkspaceDtoV1
export type GetInvoicesParams = { readonly "page"?: number, readonly "page-size"?: number, readonly "statuses"?: "UNSENT" | "SENT" | "PAID" | "PARTIALLY_PAID" | "VOID" | "OVERDUE", readonly "sort-column"?: "ID" | "CLIENT" | "DUE_ON" | "ISSUE_DATE" | "AMOUNT" | "BALANCE", readonly "sort-order"?: "ASCENDING" | "DESCENDING" }
export const GetInvoicesParams = Schema.Struct({ "page": Schema.optionalKey(Schema.Number.annotate({ "description": "Page number.", "format": "int32" }).check(Schema.isInt())), "page-size": Schema.optionalKey(Schema.Number.annotate({ "description": "Page size.", "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1))), "statuses": Schema.optionalKey(Schema.Literals(["UNSENT", "SENT", "PAID", "PARTIALLY_PAID", "VOID", "OVERDUE"])), "sort-column": Schema.optionalKey(Schema.Literals(["ID", "CLIENT", "DUE_ON", "ISSUE_DATE", "AMOUNT", "BALANCE"])), "sort-order": Schema.optionalKey(Schema.Literals(["ASCENDING", "DESCENDING"])) })
export type GetInvoices200 = InvoicesListDtoV1
export const GetInvoices200 = InvoicesListDtoV1
export type CreateInvoiceRequestJson = CreateInvoiceRequest
export const CreateInvoiceRequestJson = CreateInvoiceRequest
export type CreateInvoice201 = CreateInvoiceDtoV1
export const CreateInvoice201 = CreateInvoiceDtoV1
export type GetInvoicesInfoRequestJson = InvoiceFilterRequestV1
export const GetInvoicesInfoRequestJson = InvoiceFilterRequestV1
export type GetInvoicesInfo200 = InvoiceInfoResponseDtoV1
export const GetInvoicesInfo200 = InvoiceInfoResponseDtoV1
export type GetInvoiceSettings200 = InvoiceSettingsDtoV1
export const GetInvoiceSettings200 = InvoiceSettingsDtoV1
export type UpdateInvoiceSettingsRequestJson = UpdateInvoiceSettingsRequestV1
export const UpdateInvoiceSettingsRequestJson = UpdateInvoiceSettingsRequestV1
export type GetInvoice200 = InvoiceOverviewDtoV1
export const GetInvoice200 = InvoiceOverviewDtoV1
export type UpdateInvoiceRequestJson = UpdateInvoiceRequestV1
export const UpdateInvoiceRequestJson = UpdateInvoiceRequestV1
export type UpdateInvoice200 = InvoiceOverviewDtoV1
export const UpdateInvoice200 = InvoiceOverviewDtoV1
export type DuplicateInvoice201 = InvoiceOverviewDtoV1
export const DuplicateInvoice201 = InvoiceOverviewDtoV1
export type ExportInvoiceParams = { readonly "userLocale": string }
export const ExportInvoiceParams = Schema.Struct({ "userLocale": Schema.String.annotate({ "description": "Represents a locale." }) })
export type AddInvoiceItemRequestJson = CreateInvoiceItemRequestV1
export const AddInvoiceItemRequestJson = CreateInvoiceItemRequestV1
export type AddInvoiceItem200 = InvoiceOverviewDtoV1
export const AddInvoiceItem200 = InvoiceOverviewDtoV1
export type ImportTimeEntriesAndExpensesRequestJson = ImportTimeEntriesAndExpensesRequestV1
export const ImportTimeEntriesAndExpensesRequestJson = ImportTimeEntriesAndExpensesRequestV1
export type ImportTimeEntriesAndExpenses200 = InvoiceOverviewDtoV1
export const ImportTimeEntriesAndExpenses200 = InvoiceOverviewDtoV1
export type RemoveInvoiceItem200 = InvoiceOverviewDtoV1
export const RemoveInvoiceItem200 = InvoiceOverviewDtoV1
export type GetPaymentsForInvoiceParams = { readonly "page"?: number, readonly "page-size"?: number }
export const GetPaymentsForInvoiceParams = Schema.Struct({ "page": Schema.optionalKey(Schema.Number.annotate({ "description": "Page number.", "format": "int32" }).check(Schema.isInt())), "page-size": Schema.optionalKey(Schema.Number.annotate({ "description": "Page size.", "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1))) })
export type GetPaymentsForInvoice200 = ReadonlyArray<InvoicePaymentDtoV1>
export const GetPaymentsForInvoice200 = Schema.Array(InvoicePaymentDtoV1)
export type CreateInvoicePaymentRequestJson = CreateInvoicePaymentRequest
export const CreateInvoicePaymentRequestJson = CreateInvoicePaymentRequest
export type CreateInvoicePayment201 = InvoiceOverviewDtoV1
export const CreateInvoicePayment201 = InvoiceOverviewDtoV1
export type DeletePaymentById200 = InvoiceOverviewDtoV1
export const DeletePaymentById200 = InvoiceOverviewDtoV1
export type ChangeInvoiceStatusRequestJson = ChangeInvoiceStatusRequestV1
export const ChangeInvoiceStatusRequestJson = ChangeInvoiceStatusRequestV1
export type AddLimitedUsersRequestJson = AddLimitedUsersRequest
export const AddLimitedUsersRequestJson = AddLimitedUsersRequest
export type GetMemberProfile200 = MemberProfileDtoV1
export const GetMemberProfile200 = MemberProfileDtoV1
export type UpdateMemberProfileWithAdditionalDataRequestJson = MemberProfileFullRequestV1
export const UpdateMemberProfileWithAdditionalDataRequestJson = MemberProfileFullRequestV1
export type UpdateMemberProfileWithAdditionalData200 = MemberProfileDtoV1
export const UpdateMemberProfileWithAdditionalData200 = MemberProfileDtoV1
export type GetProjectsParams = { readonly "name"?: string, readonly "strict-name-search"?: boolean, readonly "archived"?: boolean, readonly "billable"?: boolean, readonly "clients"?: ReadonlyArray<string>, readonly "contains-client"?: boolean, readonly "client-status"?: "ACTIVE" | "ARCHIVED" | "ALL", readonly "users"?: ReadonlyArray<string>, readonly "contains-user"?: boolean, readonly "user-status"?: "PENDING" | "ACTIVE" | "DECLINED" | "INACTIVE" | "ALL", readonly "is-template"?: boolean, readonly "sort-column"?: "ID" | "NAME" | "CLIENT_NAME" | "DURATION" | "BUDGET" | "PROGRESS", readonly "sort-order"?: "ASCENDING" | "DESCENDING", readonly "hydrated"?: boolean, readonly "page"?: number, readonly "page-size"?: number, readonly "access"?: "PUBLIC" | "PRIVATE", readonly "expense-limit"?: number, readonly "expense-date"?: string, readonly "userGroups"?: ReadonlyArray<string>, readonly "contains-group"?: boolean }
export const GetProjectsParams = Schema.Struct({ "name": Schema.optionalKey(Schema.String.annotate({ "description": "If provided, you'll get a filtered list of projects that contains the provided string in the project name." })), "strict-name-search": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Flag to toggle on/off strict search mode. When set to true, search by name will only return projects whose name exactly matches the string value given for the 'name' parameter. When set to false, results will also include projects whose name contain the string value, but could be longer than the string value itself. For example, if there is a project with the name 'applications', and the search value is 'app', setting strict-name-search to true will not return that project in the results, whereas setting it to false will." })), "archived": Schema.optionalKey(Schema.Boolean.annotate({ "description": "If provided and set to true, you'll only get archived projects. If omitted, you'll get both archived and non-archived projects." })), "billable": Schema.optionalKey(Schema.Boolean.annotate({ "description": "If provided and set to true, you'll only get billable projects. If omitted, you'll get both billable and non-billable projects." })), "clients": Schema.optionalKey(Schema.Array(Schema.String.annotate({ "description": "If provided, you'll get a filtered list of projects that contain clients which match any of the provided ids." })).annotate({ "description": "If provided, you'll get a filtered list of projects that contain clients which match any of the provided ids." }).check(Schema.isUnique())), "contains-client": Schema.optionalKey(Schema.Boolean.annotate({ "description": "If set to true, you'll get a filtered list of projects that contain clients which match the provided id(s) in 'clients' field. If set to false, you'll get a filtered list of projects which do NOT contain clients that match the provided id(s) in 'clients' field." })), "client-status": Schema.optionalKey(Schema.Literals(["ACTIVE", "ARCHIVED", "ALL"])), "users": Schema.optionalKey(Schema.Array(Schema.String.annotate({ "description": "If provided, you'll get a filtered list of projects that contain users which match any of the provided ids." })).annotate({ "description": "If provided, you'll get a filtered list of projects that contain users which match any of the provided ids." }).check(Schema.isUnique())), "contains-user": Schema.optionalKey(Schema.Boolean.annotate({ "description": "If set to true, you'll get a filtered list of projects that contain users which match the provided id(s) in 'users' field. If set to false, you'll get a filtered list of projects which do NOT contain users which match the provided id(s) in 'users' field." })), "user-status": Schema.optionalKey(Schema.Literals(["PENDING", "ACTIVE", "DECLINED", "INACTIVE", "ALL"])), "is-template": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Filters projects based on whether they are used as a template or not." })), "sort-column": Schema.optionalKey(Schema.Literals(["ID", "NAME", "CLIENT_NAME", "DURATION", "BUDGET", "PROGRESS"])), "sort-order": Schema.optionalKey(Schema.Literals(["ASCENDING", "DESCENDING"])), "hydrated": Schema.optionalKey(Schema.Boolean.annotate({ "description": "If set to true, results will contain additional information about the project." })), "page": Schema.optionalKey(Schema.Number.annotate({ "description": "Page number.", "format": "int32" }).check(Schema.isInt())), "page-size": Schema.optionalKey(Schema.Number.annotate({ "description": "Page size.", "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1))), "access": Schema.optionalKey(Schema.Literals(["PUBLIC", "PRIVATE"])), "expense-limit": Schema.optionalKey(Schema.Number.annotate({ "description": "Represents the maximum number of expenses to fetch.", "format": "int32" }).check(Schema.isInt())), "expense-date": Schema.optionalKey(Schema.String.annotate({ "description": "If provided, you will get expenses dated before the provided value in yyyy-MM-dd format." })), "userGroups": Schema.optionalKey(Schema.Array(Schema.String.annotate({ "description": "If provided, you'll get a filtered list of projects that contain groups which match any of the provided ids." })).annotate({ "description": "If provided, you'll get a filtered list of projects that contain groups which match any of the provided ids." }).check(Schema.isUnique())), "contains-group": Schema.optionalKey(Schema.Boolean.annotate({ "description": "If set to true, you'll get a filtered list of projects that contain groups which match the provided id(s) in 'userGroups' field. If set to false, you'll get a filtered list of projects which do NOT contain groups which match the provided id(s) in 'userGroups' field." })) })
export type GetProjects200 = ReadonlyArray<ProjectDtoV1>
export const GetProjects200 = Schema.Array(ProjectDtoV1)
export type CreateNewProjectRequestJson = ProjectRequest
export const CreateNewProjectRequestJson = ProjectRequest
export type CreateNewProject201 = ProjectDtoImplV1
export const CreateNewProject201 = ProjectDtoImplV1
export type CreateProjectFromTemplateRequestJson = CreateProjectFromTemplateV1
export const CreateProjectFromTemplateRequestJson = CreateProjectFromTemplateV1
export type CreateProjectFromTemplate200 = ProjectDtoImplV1
export const CreateProjectFromTemplate200 = ProjectDtoImplV1
export type GetProjectParams = { readonly "hydrated"?: boolean, readonly "custom-field-entity-type"?: string, readonly "expense-limit"?: number, readonly "expense-date"?: string }
export const GetProjectParams = Schema.Struct({ "hydrated": Schema.optionalKey(Schema.Boolean.annotate({ "description": "If set to true, results will contain additional information about the project" })), "custom-field-entity-type": Schema.optionalKey(Schema.String), "expense-limit": Schema.optionalKey(Schema.Number.annotate({ "description": "Represents the maximum number of expenses to fetch.", "format": "int32" }).check(Schema.isInt())), "expense-date": Schema.optionalKey(Schema.String.annotate({ "description": "If provided, you will get expenses dated before the provided value in yyyy-MM-dd format." })) })
export type GetProject200 = ProjectDtoV1
export const GetProject200 = ProjectDtoV1
export type UpdateProjectRequestJson = UpdateProjectRequest
export const UpdateProjectRequestJson = UpdateProjectRequest
export type UpdateProject200 = ProjectDtoImplV1
export const UpdateProject200 = ProjectDtoImplV1
export type DeleteProject200 = ProjectDtoImplV1
export const DeleteProject200 = ProjectDtoImplV1
export type GetCustomFieldsOfProjectParams = { readonly "status"?: "INACTIVE" | "VISIBLE" | "INVISIBLE", readonly "entity-type"?: string }
export const GetCustomFieldsOfProjectParams = Schema.Struct({ "status": Schema.optionalKey(Schema.Literals(["INACTIVE", "VISIBLE", "INVISIBLE"])), "entity-type": Schema.optionalKey(Schema.String) })
export type GetCustomFieldsOfProject200 = ReadonlyArray<CustomFieldDtoV1>
export const GetCustomFieldsOfProject200 = Schema.Array(CustomFieldDtoV1)
export type RemoveDefaultValueOfProject200 = CustomFieldDtoV1
export const RemoveDefaultValueOfProject200 = CustomFieldDtoV1
export type EditProjectCustomFieldDefaultValueRequestJson = CustomFieldProjectDefaultValuesRequest
export const EditProjectCustomFieldDefaultValueRequestJson = CustomFieldProjectDefaultValuesRequest
export type EditProjectCustomFieldDefaultValue200 = CustomFieldDtoV1
export const EditProjectCustomFieldDefaultValue200 = CustomFieldDtoV1
export type UpdateEstimateRequestJson = ProjectEstimateRequest
export const UpdateEstimateRequestJson = ProjectEstimateRequest
export type UpdateEstimate200 = ProjectDtoImplV1
export const UpdateEstimate200 = ProjectDtoImplV1
export type AddUsersToProjectRequestJson = AddUsersToProjectRequestV1
export const AddUsersToProjectRequestJson = AddUsersToProjectRequestV1
export type UpdateMembershipsRequestJson = UpdateProjectMembershipsRequest
export const UpdateMembershipsRequestJson = UpdateProjectMembershipsRequest
export type UpdateMemberships200 = ProjectDtoImplV1
export const UpdateMemberships200 = ProjectDtoImplV1
export type GetTasksParams = { readonly "name"?: string, readonly "strict-name-search"?: boolean, readonly "is-active"?: boolean, readonly "page"?: number, readonly "page-size"?: number, readonly "sort-column"?: "ID" | "NAME", readonly "sort-order"?: "ASCENDING" | "DESCENDING" }
export const GetTasksParams = Schema.Struct({ "name": Schema.optionalKey(Schema.String.annotate({ "description": "If provided, you'll get a filtered list of tasks that matches the provided string in their name." })), "strict-name-search": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Flag to toggle on/off strict search mode. When set to true, search by name only will return tasks whose name exactly matches the string value given for the 'name' parameter. When set to false, results will also include tasks whose name contain the string value, but could be longer than the string value itself. For example, if there is a task with the name 'applications', and the search value is 'app', setting strict-name-search to true will not return that task in the results, whereas setting it to false will." })), "is-active": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Filters search results whether task is active or not." })), "page": Schema.optionalKey(Schema.Number.annotate({ "description": "Page number.", "format": "int32" }).check(Schema.isInt())), "page-size": Schema.optionalKey(Schema.Number.annotate({ "description": "Page size.", "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1))), "sort-column": Schema.optionalKey(Schema.Literals(["ID", "NAME"])), "sort-order": Schema.optionalKey(Schema.Literals(["ASCENDING", "DESCENDING"])) })
export type GetTasks200 = ReadonlyArray<TaskDtoV1>
export const GetTasks200 = Schema.Array(TaskDtoV1)
export type CreateTaskParams = { readonly "contains-assignee"?: boolean }
export const CreateTaskParams = Schema.Struct({ "contains-assignee": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Flag to set whether task will have assignee or none." })) })
export type CreateTaskRequestJson = TaskRequestV1
export const CreateTaskRequestJson = TaskRequestV1
export type CreateTask201 = TaskDtoV1
export const CreateTask201 = TaskDtoV1
export type SetTaskCostRateRequestJson = CostRateRequestV1
export const SetTaskCostRateRequestJson = CostRateRequestV1
export type SetTaskCostRate200 = TaskDtoV1
export const SetTaskCostRate200 = TaskDtoV1
export type SetTaskHourlyRateRequestJson = HourlyRateRequestV1
export const SetTaskHourlyRateRequestJson = HourlyRateRequestV1
export type SetTaskHourlyRate200 = TaskDtoV1
export const SetTaskHourlyRate200 = TaskDtoV1
export type GetTask200 = TaskDtoV1
export const GetTask200 = TaskDtoV1
export type UpdateTaskParams = { readonly "contains-assignee"?: boolean, readonly "membership-status"?: "PENDING" | "ACTIVE" | "DECLINED" | "INACTIVE" | "ALL" }
export const UpdateTaskParams = Schema.Struct({ "contains-assignee": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Flag to set whether task will have assignee or none." })), "membership-status": Schema.optionalKey(Schema.Literals(["PENDING", "ACTIVE", "DECLINED", "INACTIVE", "ALL"])) })
export type UpdateTaskRequestJson = UpdateTaskRequest
export const UpdateTaskRequestJson = UpdateTaskRequest
export type UpdateTask200 = TaskDtoV1
export const UpdateTask200 = TaskDtoV1
export type DeleteTask200 = TaskDtoV1
export const DeleteTask200 = TaskDtoV1
export type UpdateIsProjectTemplateRequestJson = PatchProjectTemplateRequest
export const UpdateIsProjectTemplateRequestJson = PatchProjectTemplateRequest
export type UpdateIsProjectTemplate200 = ProjectDtoImplV1
export const UpdateIsProjectTemplate200 = ProjectDtoImplV1
export type AddUsersCostRateRequestJson = CostRateRequestV1
export const AddUsersCostRateRequestJson = CostRateRequestV1
export type AddUsersCostRate200 = ProjectDtoImplV1
export const AddUsersCostRate200 = ProjectDtoImplV1
export type AddUsersHourlyRateRequestJson = CostRateRequestV1
export const AddUsersHourlyRateRequestJson = CostRateRequestV1
export type AddUsersHourlyRate200 = ProjectDtoImplV1
export const AddUsersHourlyRate200 = ProjectDtoImplV1
export type GetAllAssignmentsParams = { readonly "name"?: string, readonly "start": string, readonly "end": string, readonly "sort-column"?: "PROJECT" | "USER" | "ID", readonly "sort-order"?: "ASCENDING" | "DESCENDING", readonly "page"?: number, readonly "page-size"?: number }
export const GetAllAssignmentsParams = Schema.Struct({ "name": Schema.optionalKey(Schema.String.annotate({ "description": "If provided, assignments will be filtered by name" })), "start": Schema.String.annotate({ "description": "Represents a start date in the yyyy-MM-ddThh:mm:ssZ format." }), "end": Schema.String.annotate({ "description": "Represents a start date in the yyyy-MM-ddThh:mm:ssZ format." }), "sort-column": Schema.optionalKey(Schema.Literals(["PROJECT", "USER", "ID"])), "sort-order": Schema.optionalKey(Schema.Literals(["ASCENDING", "DESCENDING"])), "page": Schema.optionalKey(Schema.Number.annotate({ "description": "Page number.", "format": "int32" }).check(Schema.isInt())), "page-size": Schema.optionalKey(Schema.Number.annotate({ "description": "Page size.", "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1))) })
export type GetAllAssignments200 = ReadonlyArray<AssignmentHydratedDtoV1>
export const GetAllAssignments200 = Schema.Array(AssignmentHydratedDtoV1)
export type GetProjectTotalsParams = { readonly "search"?: string, readonly "start": string, readonly "end": string, readonly "page"?: number, readonly "page-size"?: number }
export const GetProjectTotalsParams = Schema.Struct({ "search": Schema.optionalKey(Schema.String.annotate({ "description": "Represents a term for searching projects and clients by name." })), "start": Schema.String.annotate({ "description": "Represents a start date in the yyyy-MM-ddThh:mm:ssZ format." }), "end": Schema.String.annotate({ "description": "Represents an end date in the yyyy-MM-ddThh:mm:ssZ format." }), "page": Schema.optionalKey(Schema.Number.annotate({ "description": "Page number.", "format": "int32" }).check(Schema.isInt())), "page-size": Schema.optionalKey(Schema.Number.annotate({ "description": "Page size.", "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1))) })
export type GetProjectTotals200 = ReadonlyArray<SchedulingProjectsTotalsDtoV1>
export const GetProjectTotals200 = Schema.Array(SchedulingProjectsTotalsDtoV1)
export type GetFilteredProjectTotalsRequestJson = ProjectTotalsRequestV1
export const GetFilteredProjectTotalsRequestJson = ProjectTotalsRequestV1
export type GetFilteredProjectTotals200 = ReadonlyArray<SchedulingProjectsTotalsDtoV1>
export const GetFilteredProjectTotals200 = Schema.Array(SchedulingProjectsTotalsDtoV1)
export type GetProjectTotalsForSingleProjectParams = { readonly "start": string, readonly "end": string }
export const GetProjectTotalsForSingleProjectParams = Schema.Struct({ "start": Schema.String.annotate({ "description": "Represents a start date in the yyyy-MM-ddThh:mm:ssZ format." }), "end": Schema.String.annotate({ "description": "Represents an end date in the yyyy-MM-ddThh:mm:ssZ format." }) })
export type GetProjectTotalsForSingleProject200 = SchedulingProjectsTotalsDtoV1
export const GetProjectTotalsForSingleProject200 = SchedulingProjectsTotalsDtoV1
export type PublishAssignmentsRequestJson = PublishAssignmentsRequestV1
export const PublishAssignmentsRequestJson = PublishAssignmentsRequestV1
export type CreateRecurringRequestJson = AssignmentCreateRequestV1
export const CreateRecurringRequestJson = AssignmentCreateRequestV1
export type CreateRecurring201 = ReadonlyArray<AssignmentDtoV1>
export const CreateRecurring201 = Schema.Array(AssignmentDtoV1)
export type DeleteRRecurringAssignmentParams = { readonly "seriesUpdateOption"?: "THIS_ONE" | "THIS_AND_FOLLOWING" | "ALL" }
export const DeleteRRecurringAssignmentParams = Schema.Struct({ "seriesUpdateOption": Schema.optionalKey(Schema.Literals(["THIS_ONE", "THIS_AND_FOLLOWING", "ALL"])) })
export type DeleteRRecurringAssignment200 = ReadonlyArray<AssignmentDtoV1>
export const DeleteRRecurringAssignment200 = Schema.Array(AssignmentDtoV1)
export type EditRecurringRequestJson = AssignmentUpdateRequestV1
export const EditRecurringRequestJson = AssignmentUpdateRequestV1
export type EditRecurring200 = ReadonlyArray<AssignmentDtoV1>
export const EditRecurring200 = Schema.Array(AssignmentDtoV1)
export type EditRecurringPeriodRequestJson = RecurringAssignmentRequestV1
export const EditRecurringPeriodRequestJson = RecurringAssignmentRequestV1
export type EditRecurringPeriod200 = ReadonlyArray<AssignmentDtoV1>
export const EditRecurringPeriod200 = Schema.Array(AssignmentDtoV1)
export type GetUserTotalsRequestJson = GetUserTotalsRequestV1
export const GetUserTotalsRequestJson = GetUserTotalsRequestV1
export type GetUserTotals200 = ReadonlyArray<SchedulingUsersTotalsDtoV1>
export const GetUserTotals200 = Schema.Array(SchedulingUsersTotalsDtoV1)
export type GetUserTotalsForSingleUserParams = { readonly "page"?: number, readonly "page-size"?: number, readonly "start": string, readonly "end": string }
export const GetUserTotalsForSingleUserParams = Schema.Struct({ "page": Schema.optionalKey(Schema.Number.annotate({ "description": "Page number.", "format": "int32" }).check(Schema.isInt())), "page-size": Schema.optionalKey(Schema.Number.annotate({ "description": "Page size.", "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1))), "start": Schema.String.annotate({ "description": "Represents a start date in the yyyy-MM-ddThh:mm:ssZ format." }), "end": Schema.String.annotate({ "description": "Represents an end date in the yyyy-MM-ddThh:mm:ssZ format." }) })
export type GetUserTotalsForSingleUser200 = SchedulingUsersTotalsDtoV1
export const GetUserTotalsForSingleUser200 = SchedulingUsersTotalsDtoV1
export type CopyAssignmentRequestJson = CopyAssignmentRequestV1
export const CopyAssignmentRequestJson = CopyAssignmentRequestV1
export type CopyAssignment200 = ReadonlyArray<AssignmentDtoV1>
export const CopyAssignment200 = Schema.Array(AssignmentDtoV1)
export type GetTagsParams = { readonly "name"?: string, readonly "strict-name-search"?: boolean, readonly "excluded-ids"?: string, readonly "sort-column"?: "ID" | "NAME", readonly "sort-order"?: "ASCENDING" | "DESCENDING", readonly "page"?: number, readonly "page-size"?: number, readonly "archived"?: boolean }
export const GetTagsParams = Schema.Struct({ "name": Schema.optionalKey(Schema.String.annotate({ "description": "If provided, you'll get a filtered list of tags that matches the provided string in their name." })), "strict-name-search": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Flag to toggle on/off strict search mode. When set to true, search by name will only return tags whose name exactly matches the string value given for the 'name' parameter. When set to false, results will also include tags whose name contain the string value, but could be longer than the string value itself. For example, if there is a tag with the name 'applications', and the search value is 'app', setting strict-name-search to true will not return that tag in the results, whereas setting it to false will." })), "excluded-ids": Schema.optionalKey(Schema.String), "sort-column": Schema.optionalKey(Schema.Literals(["ID", "NAME"])), "sort-order": Schema.optionalKey(Schema.Literals(["ASCENDING", "DESCENDING"])), "page": Schema.optionalKey(Schema.Number.annotate({ "description": "Page number.", "format": "int32" }).check(Schema.isInt())), "page-size": Schema.optionalKey(Schema.Number.annotate({ "description": "Page size.", "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1))), "archived": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Filters the result whether tags are archived or not." })) })
export type GetTags200 = ReadonlyArray<TagDtoV1>
export const GetTags200 = Schema.Array(TagDtoV1)
export type CreateNewTagRequestJson = TagRequest
export const CreateNewTagRequestJson = TagRequest
export type CreateNewTag201 = TagDtoV1
export const CreateNewTag201 = TagDtoV1
export type GetTag200 = TagDtoV1
export const GetTag200 = TagDtoV1
export type UpdateTagRequestJson = UpdateTagRequest
export const UpdateTagRequestJson = UpdateTagRequest
export type UpdateTag200 = TagDtoV1
export const UpdateTag200 = TagDtoV1
export type DeleteTag200 = TagDtoV1
export const DeleteTag200 = TagDtoV1
export type GetTemplatesParams = { readonly "name"?: string, readonly "cleansed"?: boolean, readonly "hydrated"?: boolean, readonly "page"?: number, readonly "page-size"?: number }
export const GetTemplatesParams = Schema.Struct({ "name": Schema.optionalKey(Schema.String.annotate({ "description": "If provided, you'll get a filtered list of templates that contain the provided string in their name." })), "cleansed": Schema.optionalKey(Schema.Boolean.annotate({ "description": "If set to true will filter out inactive template projects and tasks." })), "hydrated": Schema.optionalKey(Schema.Boolean.annotate({ "description": "If set to true will return hydrated template projects and tasks." })), "page": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt())), "page-size": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt())) })
export type GetTemplates200 = ReadonlyArray<TemplateDto>
export const GetTemplates200 = Schema.Array(TemplateDto)
export type CreateManyRequestJson = ReadonlyArray<TemplateRequest>
export const CreateManyRequestJson = Schema.Array(TemplateRequest)
export type CreateMany200 = ReadonlyArray<TemplateDtoImpl>
export const CreateMany200 = Schema.Array(TemplateDtoImpl)
export type GetTemplateParams = { readonly "cleansed"?: boolean, readonly "hydrated"?: boolean }
export const GetTemplateParams = Schema.Struct({ "cleansed": Schema.optionalKey(Schema.Boolean.annotate({ "description": "If set to true will filter out inactive template projects and tasks." })), "hydrated": Schema.optionalKey(Schema.Boolean.annotate({ "description": "If set to true will return hydrated template projects and tasks." })) })
export type GetTemplate200 = TemplateDto
export const GetTemplate200 = TemplateDto
export type Delete1200 = TemplateDtoImpl
export const Delete1200 = TemplateDtoImpl
export type UpdateRequestJson = TemplatePatchRequest
export const UpdateRequestJson = TemplatePatchRequest
export type Update200 = TemplateDtoImpl
export const Update200 = TemplateDtoImpl
export type CreateTimeEntryRequestJson = CreateTimeEntryRequest
export const CreateTimeEntryRequestJson = CreateTimeEntryRequest
export type CreateTimeEntry201 = TimeEntryDtoImplV1
export const CreateTimeEntry201 = TimeEntryDtoImplV1
export type UpdateInvoicedStatusRequestJson = UpdateInvoicedStatusRequest
export const UpdateInvoicedStatusRequestJson = UpdateInvoicedStatusRequest
export type GetInProgressTimeEntriesParams = { readonly "page"?: number, readonly "page-size"?: number }
export const GetInProgressTimeEntriesParams = Schema.Struct({ "page": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1))), "page-size": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(1000))) })
export type GetTimeEntryParams = { readonly "hydrated"?: boolean }
export const GetTimeEntryParams = Schema.Struct({ "hydrated": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Flag to set whether to include additional information of a time entry or not." })) })
export type GetTimeEntry200 = TimeEntryWithRatesDtoV1
export const GetTimeEntry200 = TimeEntryWithRatesDtoV1
export type UpdateTimeEntryRequestJson = UpdateTimeEntryRequest
export const UpdateTimeEntryRequestJson = UpdateTimeEntryRequest
export type UpdateTimeEntry200 = TimeEntryDtoImplV1
export const UpdateTimeEntry200 = TimeEntryDtoImplV1
export type GetBalancesForPolicyParams = { readonly "page"?: number, readonly "page-size"?: number, readonly "sort"?: "USER" | "POLICY" | "USED" | "BALANCE" | "TOTAL", readonly "sort-order"?: "ASCENDING" | "DESCENDING" }
export const GetBalancesForPolicyParams = Schema.Struct({ "page": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isLessThanOrEqualTo(1000))), "page-size": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(200))), "sort": Schema.optionalKey(Schema.Literals(["USER", "POLICY", "USED", "BALANCE", "TOTAL"])), "sort-order": Schema.optionalKey(Schema.Literals(["ASCENDING", "DESCENDING"])) })
export type UpdateBalanceRequestJson = UpdateBalanceRequestV1
export const UpdateBalanceRequestJson = UpdateBalanceRequestV1
export type GetBalancesForUserParams = { readonly "page"?: string, readonly "page-size"?: string, readonly "sort"?: "USER" | "POLICY" | "USED" | "BALANCE" | "TOTAL", readonly "sort-order"?: "ASCENDING" | "DESCENDING" }
export const GetBalancesForUserParams = Schema.Struct({ "page": Schema.optionalKey(Schema.String), "page-size": Schema.optionalKey(Schema.String), "sort": Schema.optionalKey(Schema.Literals(["USER", "POLICY", "USED", "BALANCE", "TOTAL"])), "sort-order": Schema.optionalKey(Schema.Literals(["ASCENDING", "DESCENDING"])) })
export type FindPoliciesForWorkspaceParams = { readonly "page"?: string, readonly "page-size"?: number, readonly "name"?: string, readonly "status"?: "ACTIVE" | "ARCHIVED" | "ALL", readonly "sort-column"?: string, readonly "sort-order"?: string }
export const FindPoliciesForWorkspaceParams = Schema.Struct({ "page": Schema.optionalKey(Schema.String), "page-size": Schema.optionalKey(Schema.Number.annotate({ "description": "Page size.", "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(200))), "name": Schema.optionalKey(Schema.String.annotate({ "description": "If provided, you'll get a filtered list of policies that contain the provided string in their name." })), "status": Schema.optionalKey(Schema.Literals(["ACTIVE", "ARCHIVED", "ALL"])), "sort-column": Schema.optionalKey(Schema.String), "sort-order": Schema.optionalKey(Schema.String) })
export type FindPoliciesForWorkspace200 = ReadonlyArray<PolicyDtoV1>
export const FindPoliciesForWorkspace200 = Schema.Array(PolicyDtoV1)
export type CreatePolicyRequestJson = CreatePolicyRequestV1
export const CreatePolicyRequestJson = CreatePolicyRequestV1
export type CreatePolicy201 = PolicyDtoV1
export const CreatePolicy201 = PolicyDtoV1
export type GetPolicy200 = PolicyDtoV1
export const GetPolicy200 = PolicyDtoV1
export type UpdatePolicyRequestJson = UpdatePolicyRequestV1
export const UpdatePolicyRequestJson = UpdatePolicyRequestV1
export type UpdatePolicy200 = PolicyDtoV1
export const UpdatePolicy200 = PolicyDtoV1
export type UpdatePolicyStatusRequestJson = ChangePolicyStatusRequestV1
export const UpdatePolicyStatusRequestJson = ChangePolicyStatusRequestV1
export type UpdatePolicyStatus200 = PolicyDtoV1
export const UpdatePolicyStatus200 = PolicyDtoV1
export type CreateTimeOffRequestRequestJson = CreateTimeOffRequestV1Request
export const CreateTimeOffRequestRequestJson = CreateTimeOffRequestV1Request
export type CreateTimeOffRequest200 = TimeOffRequestFullV1Dto
export const CreateTimeOffRequest200 = TimeOffRequestFullV1Dto
export type DeleteTimeOffRequest200 = TimeOffRequestV1Dto
export const DeleteTimeOffRequest200 = TimeOffRequestV1Dto
export type ChangeTimeOffRequestStatusRequestJson = StatusTimeOffRequestV1Request
export const ChangeTimeOffRequestStatusRequestJson = StatusTimeOffRequestV1Request
export type ChangeTimeOffRequestStatus200 = TimeOffRequestV1Dto
export const ChangeTimeOffRequestStatus200 = TimeOffRequestV1Dto
export type CreateTimeOffRequestForOtherRequestJson = CreateTimeOffRequestV1Request
export const CreateTimeOffRequestForOtherRequestJson = CreateTimeOffRequestV1Request
export type CreateTimeOffRequestForOther200 = TimeOffRequestFullV1Dto
export const CreateTimeOffRequestForOther200 = TimeOffRequestFullV1Dto
export type GetTimeOffRequestRequestJson = GetTimeOffRequestsV1Request
export const GetTimeOffRequestRequestJson = GetTimeOffRequestsV1Request
export type GetTimeOffRequest200 = TimeOffRequestsWithCountV1Dto
export const GetTimeOffRequest200 = TimeOffRequestsWithCountV1Dto
export type GetUserGroupsParams = { readonly "project-id"?: string, readonly "name"?: string, readonly "sort-column"?: "ID" | "NAME", readonly "sort-order"?: "ASCENDING" | "DESCENDING", readonly "page"?: number, readonly "page-size"?: number, readonly "includeTeamManagers"?: boolean }
export const GetUserGroupsParams = Schema.Struct({ "project-id": Schema.optionalKey(Schema.String), "name": Schema.optionalKey(Schema.String.annotate({ "description": "If provided, you'll get a filtered list of groups that matches the string provided in their name." })), "sort-column": Schema.optionalKey(Schema.Literals(["ID", "NAME"])), "sort-order": Schema.optionalKey(Schema.Literals(["ASCENDING", "DESCENDING"])), "page": Schema.optionalKey(Schema.Number.annotate({ "description": "Page number.", "format": "int32" }).check(Schema.isInt())), "page-size": Schema.optionalKey(Schema.Number.annotate({ "description": "Page size.", "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1))), "includeTeamManagers": Schema.optionalKey(Schema.Boolean.annotate({ "description": "If provided, you'll get a list of team managers assigned to this user group." })) })
export type GetUserGroups200 = ReadonlyArray<UserGroupDtoV1>
export const GetUserGroups200 = Schema.Array(UserGroupDtoV1)
export type CreateUserGroupRequestJson = UserGroupRequest
export const CreateUserGroupRequestJson = UserGroupRequest
export type CreateUserGroup201 = UserGroupDtoV1
export const CreateUserGroup201 = UserGroupDtoV1
export type UpdateUserGroupRequestJson = UpdateUserGroupRequest
export const UpdateUserGroupRequestJson = UpdateUserGroupRequest
export type UpdateUserGroup200 = UserGroupDtoV1
export const UpdateUserGroup200 = UserGroupDtoV1
export type DeleteUserGroup200 = UserGroupDtoV1
export const DeleteUserGroup200 = UserGroupDtoV1
export type AddUserRequestJson = UserGroupUserRequest
export const AddUserRequestJson = UserGroupUserRequest
export type AddUser200 = UserGroupDtoV1
export const AddUser200 = UserGroupDtoV1
export type DeleteUser200 = UserGroupDtoV1
export const DeleteUser200 = UserGroupDtoV1
export type GetTimeEntriesParams = { readonly "description"?: string, readonly "start"?: string, readonly "end"?: string, readonly "project"?: string, readonly "task"?: string, readonly "tags"?: ReadonlyArray<string>, readonly "project-required"?: boolean, readonly "task-required"?: boolean, readonly "hydrated"?: boolean, readonly "page"?: number, readonly "page-size"?: number, readonly "in-progress"?: string, readonly "get-week-before"?: string }
export const GetTimeEntriesParams = Schema.Struct({ "description": Schema.optionalKey(Schema.String.annotate({ "description": "Represents a term for searching time entries by description." })), "start": Schema.optionalKey(Schema.String.annotate({ "description": "Represents a start date in the yyyy-MM-ddThh:mm:ssZ format." })), "end": Schema.optionalKey(Schema.String.annotate({ "description": "Represents an end date in the yyyy-MM-ddThh:mm:ssZ format." })), "project": Schema.optionalKey(Schema.String.annotate({ "description": "If provided, you'll get a filtered list of time entries that matches the provided string in their project id." })), "task": Schema.optionalKey(Schema.String.annotate({ "description": "If provided, you'll get a filtered list of time entries that matches the provided string in their task id." })), "tags": Schema.optionalKey(Schema.Array(Schema.String.annotate({ "description": "If provided, you'll get a filtered list of time entries that matches the provided string(s) in their tag id(s)." })).annotate({ "description": "If provided, you'll get a filtered list of time entries that matches the provided string(s) in their tag id(s)." }).check(Schema.isUnique())), "project-required": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Flag to set whether to only get time entries which have a project." })), "task-required": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Flag to set whether to only get time entries which have tasks." })), "hydrated": Schema.optionalKey(Schema.Boolean.annotate({ "description": "Flag to set whether to include additional information on time entries or not." })), "page": Schema.optionalKey(Schema.Number.annotate({ "description": "Page number.", "format": "int32" }).check(Schema.isInt())), "page-size": Schema.optionalKey(Schema.Number.annotate({ "description": "Page size.", "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1))), "in-progress": Schema.optionalKey(Schema.String), "get-week-before": Schema.optionalKey(Schema.String.annotate({ "description": "Valid yyyy-MM-ddThh:mm:ssZ format date. If provided, filters results within the week before the datetime provided and only those entries with assigned project or task." })) })
export type GetTimeEntries200 = ReadonlyArray<TimeEntryWithRatesDtoV1>
export const GetTimeEntries200 = Schema.Array(TimeEntryWithRatesDtoV1)
export type ReplaceManyParams = { readonly "hydrated"?: boolean }
export const ReplaceManyParams = Schema.Struct({ "hydrated": Schema.optionalKey(Schema.Boolean.annotate({ "description": "If set to true, results will contain additional information about the time entry." })) })
export type ReplaceManyRequestJson = ReadonlyArray<UpdateTimeEntryBulkRequest>
export const ReplaceManyRequestJson = Schema.Array(UpdateTimeEntryBulkRequest).check(Schema.isMinLength(1))
export type ReplaceMany200 = ReadonlyArray<TimeEntryDtoV1>
export const ReplaceMany200 = Schema.Array(TimeEntryDtoV1)
export type CreateForOthersParams = { readonly "from-entry"?: string }
export const CreateForOthersParams = Schema.Struct({ "from-entry": Schema.optionalKey(Schema.String.annotate({ "description": "Represents a time entry identifier across the system." })) })
export type CreateForOthersRequestJson = CreateTimeEntryRequest
export const CreateForOthersRequestJson = CreateTimeEntryRequest
export type CreateForOthers201 = TimeEntryDtoImplV1
export const CreateForOthers201 = TimeEntryDtoImplV1
export type DeleteManyParams = { readonly "time-entry-ids": ReadonlyArray<string> }
export const DeleteManyParams = Schema.Struct({ "time-entry-ids": Schema.Array(Schema.String.annotate({ "description": "Represents a list of time entry ids to delete." })).annotate({ "description": "Represents a list of time entry ids to delete." }) })
export type DeleteMany200 = ReadonlyArray<TimeEntryDtoImplV1>
export const DeleteMany200 = Schema.Array(TimeEntryDtoImplV1)
export type StopRunningTimeEntryRequestJson = StopTimeEntryRequest
export const StopRunningTimeEntryRequestJson = StopTimeEntryRequest
export type StopRunningTimeEntry200 = TimeEntryDtoImplV1
export const StopRunningTimeEntry200 = TimeEntryDtoImplV1
export type DuplicateTimeEntry201 = TimeEntryDtoImplV1
export const DuplicateTimeEntry201 = TimeEntryDtoImplV1
export type GetUsersOfWorkspaceParams = { readonly "email"?: string, readonly "project-id"?: string, readonly "status"?: "PENDING" | "ACTIVE" | "DECLINED" | "INACTIVE" | "ALL", readonly "account-statuses"?: string, readonly "name"?: string, readonly "sort-column"?: "ID" | "EMAIL" | "NAME" | "NAME_LOWERCASE" | "ACCESS" | "HOURLYRATE" | "COSTRATE", readonly "sort-order"?: "ASCENDING" | "DESCENDING", readonly "page"?: number, readonly "page-size"?: number, readonly "memberships"?: "ALL" | "NONE" | "WORKSPACE" | "PROJECT" | "USERGROUP", readonly "include-roles": string }
export const GetUsersOfWorkspaceParams = Schema.Struct({ "email": Schema.optionalKey(Schema.String.annotate({ "description": "If provided, you'll get a filtered list of users that contain the provided string in their email address." })), "project-id": Schema.optionalKey(Schema.String), "status": Schema.optionalKey(Schema.Literals(["PENDING", "ACTIVE", "DECLINED", "INACTIVE", "ALL"])), "account-statuses": Schema.optionalKey(Schema.String), "name": Schema.optionalKey(Schema.String.annotate({ "description": "If provided, you'll get a filtered list of users that contain the provided string in their name" })), "sort-column": Schema.optionalKey(Schema.Literals(["ID", "EMAIL", "NAME", "NAME_LOWERCASE", "ACCESS", "HOURLYRATE", "COSTRATE"])), "sort-order": Schema.optionalKey(Schema.Literals(["ASCENDING", "DESCENDING"])), "page": Schema.optionalKey(Schema.Number.annotate({ "description": "Page number.", "format": "int32" }).check(Schema.isInt())), "page-size": Schema.optionalKey(Schema.Number.annotate({ "description": "Page size.", "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1))), "memberships": Schema.optionalKey(Schema.Literals(["ALL", "NONE", "WORKSPACE", "PROJECT", "USERGROUP"])), "include-roles": Schema.String })
export type GetUsersOfWorkspace200 = ReadonlyArray<UserDtoV1>
export const GetUsersOfWorkspace200 = Schema.Array(UserDtoV1)
export type AddUsersParams = { readonly "send-email": string }
export const AddUsersParams = Schema.Struct({ "send-email": Schema.String })
export type AddUsersRequestJson = AddUserToWorkspaceRequest
export const AddUsersRequestJson = AddUserToWorkspaceRequest
export type AddUsers200 = WorkspaceDtoV1
export const AddUsers200 = WorkspaceDtoV1
export type FilterUsersOfWorkspaceRequestJson = GetUsersRequestV1
export const FilterUsersOfWorkspaceRequestJson = GetUsersRequestV1
export type FilterUsersOfWorkspace200 = ReadonlyArray<UserDtoV1>
export const FilterUsersOfWorkspace200 = Schema.Array(UserDtoV1)
export type UpdateUserStatusRequestJson = UpdateUserStatusRequest
export const UpdateUserStatusRequestJson = UpdateUserStatusRequest
export type UpdateUserStatus200 = WorkspaceDtoV1
export const UpdateUserStatus200 = WorkspaceDtoV1
export type RemoveMember200 = WorkspaceDtoV1
export const RemoveMember200 = WorkspaceDtoV1
export type SetCostRateForUserRequestJson = CostRateRequestV1
export const SetCostRateForUserRequestJson = CostRateRequestV1
export type SetCostRateForUser200 = WorkspaceDtoV1
export const SetCostRateForUser200 = WorkspaceDtoV1
export type UpsertUserCustomFieldValueRequestJson = UpsertUserCustomFieldRequestV1
export const UpsertUserCustomFieldValueRequestJson = UpsertUserCustomFieldRequestV1
export type UpsertUserCustomFieldValue201 = UserCustomFieldValueDtoV1
export const UpsertUserCustomFieldValue201 = UserCustomFieldValueDtoV1
export type SetHourlyRateForUserRequestJson = HourlyRateRequestV1
export const SetHourlyRateForUserRequestJson = HourlyRateRequestV1
export type SetHourlyRateForUser200 = WorkspaceDtoV1
export const SetHourlyRateForUser200 = WorkspaceDtoV1
export type GetManagersOfUserParams = { readonly "sort-column"?: "ID" | "EMAIL" | "NAME" | "NAME_LOWERCASE" | "ACCESS" | "HOURLYRATE" | "COSTRATE", readonly "sort-order"?: "ASCENDING" | "DESCENDING", readonly "page"?: number, readonly "page-size"?: number }
export const GetManagersOfUserParams = Schema.Struct({ "sort-column": Schema.optionalKey(Schema.Literals(["ID", "EMAIL", "NAME", "NAME_LOWERCASE", "ACCESS", "HOURLYRATE", "COSTRATE"])), "sort-order": Schema.optionalKey(Schema.Literals(["ASCENDING", "DESCENDING"])), "page": Schema.optionalKey(Schema.Number.annotate({ "description": "Page number.", "format": "int32" }).check(Schema.isInt())), "page-size": Schema.optionalKey(Schema.Number.annotate({ "description": "Page size.", "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1))) })
export type GetManagersOfUser200 = ReadonlyArray<UserDtoV1>
export const GetManagersOfUser200 = Schema.Array(UserDtoV1)
export type CreateUserRoleRequestJson = RoleRequestV1
export const CreateUserRoleRequestJson = RoleRequestV1
export type CreateUserRole201 = ReadonlyArray<RoleDetailsDtoV1>
export const CreateUserRole201 = Schema.Array(RoleDetailsDtoV1)
export type DeleteUserRoleRequestJson = RoleRequestV1
export const DeleteUserRoleRequestJson = RoleRequestV1
export type GetWebhooksParams = { readonly "type"?: "USER_CREATED" | "SYSTEM" | "ADDON" }
export const GetWebhooksParams = Schema.Struct({ "type": Schema.optionalKey(Schema.Literals(["USER_CREATED", "SYSTEM", "ADDON"])) })
export type GetWebhooks200 = WebhooksDtoV1
export const GetWebhooks200 = WebhooksDtoV1
export type CreateWebhookRequestJson = CreateWebhookRequestV1
export const CreateWebhookRequestJson = CreateWebhookRequestV1
export type CreateWebhook201 = WebhookDtoV1
export const CreateWebhook201 = WebhookDtoV1
export type GetWebhook200 = WebhookDtoV1
export const GetWebhook200 = WebhookDtoV1
export type UpdateWebhookRequestJson = UpdateWebhookRequestV1
export const UpdateWebhookRequestJson = UpdateWebhookRequestV1
export type UpdateWebhook200 = WebhookDtoV1
export const UpdateWebhook200 = WebhookDtoV1
export type GetLogsForWebhookParams = { readonly "page"?: number, readonly "size"?: number }
export const GetLogsForWebhookParams = Schema.Struct({ "page": Schema.optionalKey(Schema.Number.annotate({ "description": "Page number.", "format": "int32" }).check(Schema.isInt())), "size": Schema.optionalKey(Schema.Number.annotate({ "description": "Page size.", "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1))) })
export type GetLogsForWebhookRequestJson = WebhookLogSearchRequestV1
export const GetLogsForWebhookRequestJson = WebhookLogSearchRequestV1
export type GetLogsForWebhook200 = ReadonlyArray<WebhookLogDtoV1>
export const GetLogsForWebhook200 = Schema.Array(WebhookLogDtoV1)
export type GetWebhookEventStatusesWithLatestLogParams = { readonly "page"?: number, readonly "size"?: number, readonly "statuses"?: "SUCCEEDED" | "RETRYING" | "FAILED" }
export const GetWebhookEventStatusesWithLatestLogParams = Schema.Struct({ "page": Schema.optionalKey(Schema.Number.annotate({ "description": "Page number.", "format": "int32" }).check(Schema.isInt())), "size": Schema.optionalKey(Schema.Number.annotate({ "description": "Page size.", "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1))), "statuses": Schema.optionalKey(Schema.Literals(["SUCCEEDED", "RETRYING", "FAILED"])) })
export type GetWebhookEventStatusesWithLatestLog200 = ReadonlyArray<WebhookEventStatusWithLatestLogDtoV1>
export const GetWebhookEventStatusesWithLatestLog200 = Schema.Array(WebhookEventStatusWithLatestLogDtoV1)
export type GenerateNewToken200 = WebhookDtoV1
export const GenerateNewToken200 = WebhookDtoV1
export type GenerateSharedReportV1Params = { readonly "dateRangeStart"?: string, readonly "dateRangeEnd"?: string, readonly "sortOrder"?: string, readonly "sortColumn"?: string, readonly "exportType"?: string, readonly "page"?: number, readonly "pageSize"?: number }
export const GenerateSharedReportV1Params = Schema.Struct({ "dateRangeStart": Schema.optionalKey(Schema.String.annotate({ "description": "Provide the start date in format YYYY-MM-DDTHH:MM:SS.ssssss. The system interprets this value based on the user's timezone (provided in the timeZone request parameter or the timezone configured in the user profile)" })), "dateRangeEnd": Schema.optionalKey(Schema.String.annotate({ "description": "Provide the end date in format YYYY-MM-DDTHH:MM:SS.ssssss. The system interprets this value based on the user's timezone (provided in the timeZone request parameter or the timezone configured in the user profile)" })), "sortOrder": Schema.optionalKey(Schema.String.annotate({ "description": "Sort result in ascending or descending order" })), "sortColumn": Schema.optionalKey(Schema.String.annotate({ "description": "If provided, you'll get result sorted by sort column." })), "exportType": Schema.optionalKey(Schema.String.annotate({ "description": "Represents an export type of shared report" })), "page": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt())), "pageSize": Schema.optionalKey(Schema.Number.annotate({ "format": "int32" }).check(Schema.isInt())) })
export type GenerateAttendanceReportRequestJson = AttendanceReportFilterV1
export const GenerateAttendanceReportRequestJson = AttendanceReportFilterV1
export type GenerateDetailedReportRequestJson = DetailedReportFilterV1
export const GenerateDetailedReportRequestJson = DetailedReportFilterV1
export type GenerateDetailedReportV1RequestJson = ExpenseReportFilterV1
export const GenerateDetailedReportV1RequestJson = ExpenseReportFilterV1
export type GenerateDetailedReportV1200 = ExpenseDetailedReportDtoV1
export const GenerateDetailedReportV1200 = ExpenseDetailedReportDtoV1
export type GenerateSummaryReportRequestJson = SummaryReportFilterV1
export const GenerateSummaryReportRequestJson = SummaryReportFilterV1
export type GenerateWeeklyReportRequestJson = WeeklyReportFilterV1
export const GenerateWeeklyReportRequestJson = WeeklyReportFilterV1
export type GetSharedReportsV1Params = { readonly "page"?: number, readonly "pageSize"?: number, readonly "sharedReportsFilter"?: "ALL" | "ALL_ADMIN" | "CREATED_BY_ME" | "SHARED_WITH_ME" }
export const GetSharedReportsV1Params = Schema.Struct({ "page": Schema.optionalKey(Schema.Number.annotate({ "description": "Page number.", "format": "int32" }).check(Schema.isInt())), "pageSize": Schema.optionalKey(Schema.Number.annotate({ "description": "Page size.", "format": "int32" }).check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1))), "sharedReportsFilter": Schema.optionalKey(Schema.Literals(["ALL", "ALL_ADMIN", "CREATED_BY_ME", "SHARED_WITH_ME"]).annotate({ "description": "Filters shared reports by origin." })) })
export type SaveSharedReportV1RequestJson = SharedReportRequestV1
export const SaveSharedReportV1RequestJson = SharedReportRequestV1
export type UpdateSharedReportV1RequestJson = UpdateSharedReportRequestV1
export const UpdateSharedReportV1RequestJson = UpdateSharedReportRequestV1
export type GetAuditLogsRequestJson = AuditLogGetRequestV1
export const GetAuditLogsRequestJson = AuditLogGetRequestV1
export type GetAuditLogs200 = PageableV1ListAuditLogDtoV1
export const GetAuditLogs200 = PageableV1ListAuditLogDtoV1

export interface OperationConfig {
  /**
   * Whether or not the response should be included in the value returned from
   * an operation.
   *
   * If set to `true`, a tuple of `[A, HttpClientResponse]` will be returned,
   * where `A` is the success type of the operation.
   *
   * If set to `false`, only the success type of the operation will be returned.
   */
  readonly includeResponse?: boolean | undefined
}

/**
 * A utility type which optionally includes the response in the return result
 * of an operation based upon the value of the `includeResponse` configuration
 * option.
 */
export type WithOptionalResponse<A, Config extends OperationConfig> = Config extends {
  readonly includeResponse: true
} ? [A, HttpClientResponse.HttpClientResponse] : A

export const make = (
  httpClient: HttpClient.HttpClient,
  options: {
    readonly transformClient?: ((client: HttpClient.HttpClient) => Effect.Effect<HttpClient.HttpClient>) | undefined
  } = {}
): ClockifyApi => {
  const unexpectedStatus = (response: HttpClientResponse.HttpClientResponse) =>
    Effect.flatMap(
      Effect.orElseSucceed(response.json, () => "Unexpected status code"),
      (description) =>
        Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.StatusCodeError({
              request: response.request,
              response,
              description: typeof description === "string" ? description : JSON.stringify(description),
            }),
          }),
        ),
    )
  const withResponse = <Config extends OperationConfig>(config: Config | undefined) => (
    f: (response: HttpClientResponse.HttpClientResponse) => Effect.Effect<any, any>,
  ): (request: HttpClientRequest.HttpClientRequest) => Effect.Effect<any, any> => {
    const withOptionalResponse = (
      config?.includeResponse
        ? (response: HttpClientResponse.HttpClientResponse) => Effect.map(f(response), (a) => [a, response])
        : (response: HttpClientResponse.HttpClientResponse) => f(response)
    ) as any
    return options?.transformClient
      ? (request) =>
          Effect.flatMap(
            Effect.flatMap(options.transformClient!(httpClient), (client) => client.execute(request)),
            withOptionalResponse
          )
      : (request) => Effect.flatMap(httpClient.execute(request), withOptionalResponse)
  }
  const decodeSuccess =
    <Schema extends Schema.Constraint>(schema: Schema) =>
    (response: HttpClientResponse.HttpClientResponse) =>
      HttpClientResponse.schemaBodyJson(schema)(response)
  return {
    httpClient,
    "uploadImage": (options) => HttpClientRequest.post(`/v1/file/image`).pipe(
    HttpClientRequest.bodyFormDataRecord(options.payload as any),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(UploadImage200),
      orElse: unexpectedStatus
    }))
  ),
    "getLoggedUser": (options) => HttpClientRequest.get(`/v1/user`).pipe(
    HttpClientRequest.setUrlParams({ "include-memberships": options?.params?.["include-memberships"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetLoggedUser200),
      orElse: unexpectedStatus
    }))
  ),
    "getWorkspacesOfUser": (options) => HttpClientRequest.get(`/v1/workspaces`).pipe(
    HttpClientRequest.setUrlParams({ "roles": options?.params?.["roles"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetWorkspacesOfUser200),
      orElse: unexpectedStatus
    }))
  ),
    "createWorkspace": (options) => HttpClientRequest.post(`/v1/workspaces`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(CreateWorkspace201),
      orElse: unexpectedStatus
    }))
  ),
    "getWorkspaceOfUser": (workspaceId, options) => HttpClientRequest.get(`/v1/workspaces/${workspaceId}`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetWorkspaceOfUser200),
      orElse: unexpectedStatus
    }))
  ),
    "getAddonWebhooks": (workspaceId, addonId, options) => HttpClientRequest.get(`/v1/workspaces/${workspaceId}/addons/${addonId}/webhooks`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetAddonWebhooks200),
      orElse: unexpectedStatus
    }))
  ),
    "getApprovalRequests": (workspaceId, options) => HttpClientRequest.get(`/v1/workspaces/${workspaceId}/approval-requests`).pipe(
    HttpClientRequest.setUrlParams({ "status": options?.params?.["status"] as any, "sort-column": options?.params?.["sort-column"] as any, "sort-order": options?.params?.["sort-order"] as any, "page": options?.params?.["page"] as any, "page-size": options?.params?.["page-size"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetApprovalRequests200),
      orElse: unexpectedStatus
    }))
  ),
    "createApprrovalRequest": (workspaceId, options) => HttpClientRequest.post(`/v1/workspaces/${workspaceId}/approval-requests`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(CreateApprrovalRequest201),
      orElse: unexpectedStatus
    }))
  ),
    "resubmitApprovalRequest": (workspaceId, options) => HttpClientRequest.post(`/v1/workspaces/${workspaceId}/approval-requests/resubmit-entries-for-approval`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      orElse: unexpectedStatus
    }))
  ),
    "createApprovalForOther": (workspaceId, userId, options) => HttpClientRequest.post(`/v1/workspaces/${workspaceId}/approval-requests/users/${userId}`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(CreateApprovalForOther201),
      orElse: unexpectedStatus
    }))
  ),
    "resubmitApprovalRequestForOther": (workspaceId, userId, options) => HttpClientRequest.post(`/v1/workspaces/${workspaceId}/approval-requests/users/${userId}/resubmit-entries-for-approval`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      orElse: unexpectedStatus
    }))
  ),
    "updateApprovalStatus": (workspaceId, approvalRequestId, options) => HttpClientRequest.patch(`/v1/workspaces/${workspaceId}/approval-requests/${approvalRequestId}`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(UpdateApprovalStatus200),
      orElse: unexpectedStatus
    }))
  ),
    "getClients": (workspaceId, options) => HttpClientRequest.get(`/v1/workspaces/${workspaceId}/clients`).pipe(
    HttpClientRequest.setUrlParams({ "name": options?.params?.["name"] as any, "sort-column": options?.params?.["sort-column"] as any, "sort-order": options?.params?.["sort-order"] as any, "page": options?.params?.["page"] as any, "page-size": options?.params?.["page-size"] as any, "archived": options?.params?.["archived"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetClients200),
      orElse: unexpectedStatus
    }))
  ),
    "createClient": (workspaceId, options) => HttpClientRequest.post(`/v1/workspaces/${workspaceId}/clients`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(CreateClient201),
      orElse: unexpectedStatus
    }))
  ),
    "getClient": (workspaceId, id, options) => HttpClientRequest.get(`/v1/workspaces/${workspaceId}/clients/${id}`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetClient200),
      orElse: unexpectedStatus
    }))
  ),
    "updateClient": (workspaceId, id, options) => HttpClientRequest.put(`/v1/workspaces/${workspaceId}/clients/${id}`).pipe(
    HttpClientRequest.setUrlParams({ "archive-projects": options.params?.["archive-projects"] as any, "mark-tasks-as-done": options.params?.["mark-tasks-as-done"] as any }),
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(UpdateClient200),
      orElse: unexpectedStatus
    }))
  ),
    "deleteClient": (workspaceId, id, options) => HttpClientRequest.delete(`/v1/workspaces/${workspaceId}/clients/${id}`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(DeleteClient200),
      orElse: unexpectedStatus
    }))
  ),
    "setWorkspaceCostRate": (workspaceId, options) => HttpClientRequest.put(`/v1/workspaces/${workspaceId}/cost-rate`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(SetWorkspaceCostRate200),
      orElse: unexpectedStatus
    }))
  ),
    "ofWorkspace": (workspaceId, options) => HttpClientRequest.get(`/v1/workspaces/${workspaceId}/custom-fields`).pipe(
    HttpClientRequest.setUrlParams({ "name": options?.params?.["name"] as any, "status": options?.params?.["status"] as any, "entity-type": options?.params?.["entity-type"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(OfWorkspace200),
      orElse: unexpectedStatus
    }))
  ),
    "create": (workspaceId, options) => HttpClientRequest.post(`/v1/workspaces/${workspaceId}/custom-fields`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      orElse: unexpectedStatus
    }))
  ),
    "editCustomField": (workspaceId, customFieldId, options) => HttpClientRequest.put(`/v1/workspaces/${workspaceId}/custom-fields/${customFieldId}`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(EditCustomField200),
      orElse: unexpectedStatus
    }))
  ),
    "delete": (workspaceId, customFieldId, options) => HttpClientRequest.delete(`/v1/workspaces/${workspaceId}/custom-fields/${customFieldId}`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "204": () => Effect.void,
      orElse: unexpectedStatus
    }))
  ),
    "getCreatedEntityInfo": (workspaceId, options) => HttpClientRequest.get(`/v1/workspaces/${workspaceId}/entities/created`).pipe(
    HttpClientRequest.setUrlParams({ "type": options.params["type"] as any, "start": options.params["start"] as any, "end": options.params["end"] as any, "page": options.params["page"] as any, "limit": options.params["limit"] as any }),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetCreatedEntityInfo200),
      orElse: unexpectedStatus
    }))
  ),
    "getDeletedEntityInfo": (workspaceId, options) => HttpClientRequest.get(`/v1/workspaces/${workspaceId}/entities/deleted`).pipe(
    HttpClientRequest.setUrlParams({ "type": options.params["type"] as any, "start": options.params["start"] as any, "end": options.params["end"] as any, "page": options.params["page"] as any, "limit": options.params["limit"] as any }),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetDeletedEntityInfo200),
      orElse: unexpectedStatus
    }))
  ),
    "getUpdatedEntityInfo": (workspaceId, options) => HttpClientRequest.get(`/v1/workspaces/${workspaceId}/entities/updated`).pipe(
    HttpClientRequest.setUrlParams({ "type": options.params["type"] as any, "start": options.params["start"] as any, "end": options.params["end"] as any, "page": options.params["page"] as any, "limit": options.params["limit"] as any }),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetUpdatedEntityInfo200),
      orElse: unexpectedStatus
    }))
  ),
    "getExpenses": (workspaceId, options) => HttpClientRequest.get(`/v1/workspaces/${workspaceId}/expenses`).pipe(
    HttpClientRequest.setUrlParams({ "page": options?.params?.["page"] as any, "page-size": options?.params?.["page-size"] as any, "user-id": options?.params?.["user-id"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetExpenses200),
      orElse: unexpectedStatus
    }))
  ),
    "createExpense": (workspaceId, options) => HttpClientRequest.post(`/v1/workspaces/${workspaceId}/expenses`).pipe(
    HttpClientRequest.bodyFormDataRecord(options.payload as any),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(CreateExpense201),
      orElse: unexpectedStatus
    }))
  ),
    "getCategories": (workspaceId, options) => HttpClientRequest.get(`/v1/workspaces/${workspaceId}/expenses/categories`).pipe(
    HttpClientRequest.setUrlParams({ "sort-column": options?.params?.["sort-column"] as any, "sort-order": options?.params?.["sort-order"] as any, "page": options?.params?.["page"] as any, "page-size": options?.params?.["page-size"] as any, "archived": options?.params?.["archived"] as any, "name": options?.params?.["name"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetCategories200),
      orElse: unexpectedStatus
    }))
  ),
    "createExpenseCategory": (workspaceId, options) => HttpClientRequest.post(`/v1/workspaces/${workspaceId}/expenses/categories`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(CreateExpenseCategory201),
      orElse: unexpectedStatus
    }))
  ),
    "updateCategory": (workspaceId, categoryId, options) => HttpClientRequest.put(`/v1/workspaces/${workspaceId}/expenses/categories/${categoryId}`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(UpdateCategory200),
      orElse: unexpectedStatus
    }))
  ),
    "deleteCategory": (workspaceId, categoryId, options) => HttpClientRequest.delete(`/v1/workspaces/${workspaceId}/expenses/categories/${categoryId}`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "204": () => Effect.void,
      orElse: unexpectedStatus
    }))
  ),
    "updateExpenseCategoryStatus": (workspaceId, categoryId, options) => HttpClientRequest.patch(`/v1/workspaces/${workspaceId}/expenses/categories/${categoryId}/status`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(UpdateExpenseCategoryStatus200),
      orElse: unexpectedStatus
    }))
  ),
    "getExpense": (workspaceId, expenseId, options) => HttpClientRequest.get(`/v1/workspaces/${workspaceId}/expenses/${expenseId}`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetExpense200),
      orElse: unexpectedStatus
    }))
  ),
    "updateExpense": (workspaceId, expenseId, options) => HttpClientRequest.put(`/v1/workspaces/${workspaceId}/expenses/${expenseId}`).pipe(
    HttpClientRequest.bodyFormDataRecord(options.payload as any),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(UpdateExpense200),
      orElse: unexpectedStatus
    }))
  ),
    "deleteExpense": (workspaceId, expenseId, options) => HttpClientRequest.delete(`/v1/workspaces/${workspaceId}/expenses/${expenseId}`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "200": () => Effect.void,
      orElse: unexpectedStatus
    }))
  ),
    "downloadFile": (workspaceId, expenseId, fileId, options) => HttpClientRequest.get(`/v1/workspaces/${workspaceId}/expenses/${expenseId}/files/${fileId}`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      orElse: unexpectedStatus
    }))
  ),
    "getHolidays": (workspaceId, options) => HttpClientRequest.get(`/v1/workspaces/${workspaceId}/holidays`).pipe(
    HttpClientRequest.setUrlParams({ "assigned-to": options?.params?.["assigned-to"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetHolidays200),
      orElse: unexpectedStatus
    }))
  ),
    "createHoliday": (workspaceId, options) => HttpClientRequest.post(`/v1/workspaces/${workspaceId}/holidays`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(CreateHoliday200),
      orElse: unexpectedStatus
    }))
  ),
    "getHolidaysInPeriod": (workspaceId, options) => HttpClientRequest.get(`/v1/workspaces/${workspaceId}/holidays/in-period`).pipe(
    HttpClientRequest.setUrlParams({ "assigned-to": options.params["assigned-to"] as any, "start": options.params["start"] as any, "end": options.params["end"] as any }),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetHolidaysInPeriod200),
      orElse: unexpectedStatus
    }))
  ),
    "updateHoliday": (workspaceId, holidayId, options) => HttpClientRequest.put(`/v1/workspaces/${workspaceId}/holidays/${holidayId}`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(UpdateHoliday200),
      orElse: unexpectedStatus
    }))
  ),
    "deleteHoliday": (workspaceId, holidayId, options) => HttpClientRequest.delete(`/v1/workspaces/${workspaceId}/holidays/${holidayId}`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(DeleteHoliday200),
      orElse: unexpectedStatus
    }))
  ),
    "setWorkspaceHourlyRate": (workspaceId, options) => HttpClientRequest.put(`/v1/workspaces/${workspaceId}/hourly-rate`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(SetWorkspaceHourlyRate200),
      orElse: unexpectedStatus
    }))
  ),
    "getInvoices": (workspaceId, options) => HttpClientRequest.get(`/v1/workspaces/${workspaceId}/invoices`).pipe(
    HttpClientRequest.setUrlParams({ "page": options?.params?.["page"] as any, "page-size": options?.params?.["page-size"] as any, "statuses": options?.params?.["statuses"] as any, "sort-column": options?.params?.["sort-column"] as any, "sort-order": options?.params?.["sort-order"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetInvoices200),
      orElse: unexpectedStatus
    }))
  ),
    "createInvoice": (workspaceId, options) => HttpClientRequest.post(`/v1/workspaces/${workspaceId}/invoices`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(CreateInvoice201),
      orElse: unexpectedStatus
    }))
  ),
    "getInvoicesInfo": (workspaceId, options) => HttpClientRequest.post(`/v1/workspaces/${workspaceId}/invoices/info`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetInvoicesInfo200),
      orElse: unexpectedStatus
    }))
  ),
    "getInvoiceSettings": (workspaceId, options) => HttpClientRequest.get(`/v1/workspaces/${workspaceId}/invoices/settings`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetInvoiceSettings200),
      orElse: unexpectedStatus
    }))
  ),
    "updateInvoiceSettings": (workspaceId, options) => HttpClientRequest.put(`/v1/workspaces/${workspaceId}/invoices/settings`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "200": () => Effect.void,
      orElse: unexpectedStatus
    }))
  ),
    "getInvoice": (workspaceId, invoiceId, options) => HttpClientRequest.get(`/v1/workspaces/${workspaceId}/invoices/${invoiceId}`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetInvoice200),
      orElse: unexpectedStatus
    }))
  ),
    "updateInvoice": (workspaceId, invoiceId, options) => HttpClientRequest.put(`/v1/workspaces/${workspaceId}/invoices/${invoiceId}`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(UpdateInvoice200),
      orElse: unexpectedStatus
    }))
  ),
    "deleteInvoice": (workspaceId, invoiceId, options) => HttpClientRequest.delete(`/v1/workspaces/${workspaceId}/invoices/${invoiceId}`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "200": () => Effect.void,
      orElse: unexpectedStatus
    }))
  ),
    "duplicateInvoice": (workspaceId, invoiceId, options) => HttpClientRequest.post(`/v1/workspaces/${workspaceId}/invoices/${invoiceId}/duplicate`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(DuplicateInvoice201),
      orElse: unexpectedStatus
    }))
  ),
    "exportInvoice": (workspaceId, invoiceId, options) => HttpClientRequest.get(`/v1/workspaces/${workspaceId}/invoices/${invoiceId}/export`).pipe(
    HttpClientRequest.setUrlParams({ "userLocale": options.params["userLocale"] as any }),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      orElse: unexpectedStatus
    }))
  ),
    "addInvoiceItem": (workspaceId, invoiceId, options) => HttpClientRequest.post(`/v1/workspaces/${workspaceId}/invoices/${invoiceId}/items`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(AddInvoiceItem200),
      orElse: unexpectedStatus
    }))
  ),
    "importTimeEntriesAndExpenses": (workspaceId, invoiceId, options) => HttpClientRequest.post(`/v1/workspaces/${workspaceId}/invoices/${invoiceId}/items/import`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(ImportTimeEntriesAndExpenses200),
      orElse: unexpectedStatus
    }))
  ),
    "removeInvoiceItem": (workspaceId, invoiceId, order, options) => HttpClientRequest.delete(`/v1/workspaces/${workspaceId}/invoices/${invoiceId}/items/${order}`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(RemoveInvoiceItem200),
      orElse: unexpectedStatus
    }))
  ),
    "getPaymentsForInvoice": (workspaceId, invoiceId, options) => HttpClientRequest.get(`/v1/workspaces/${workspaceId}/invoices/${invoiceId}/payments`).pipe(
    HttpClientRequest.setUrlParams({ "page": options?.params?.["page"] as any, "page-size": options?.params?.["page-size"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetPaymentsForInvoice200),
      orElse: unexpectedStatus
    }))
  ),
    "createInvoicePayment": (workspaceId, invoiceId, options) => HttpClientRequest.post(`/v1/workspaces/${workspaceId}/invoices/${invoiceId}/payments`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(CreateInvoicePayment201),
      orElse: unexpectedStatus
    }))
  ),
    "deletePaymentById": (workspaceId, invoiceId, paymentId, options) => HttpClientRequest.delete(`/v1/workspaces/${workspaceId}/invoices/${invoiceId}/payments/${paymentId}`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(DeletePaymentById200),
      orElse: unexpectedStatus
    }))
  ),
    "changeInvoiceStatus": (workspaceId, invoiceId, options) => HttpClientRequest.patch(`/v1/workspaces/${workspaceId}/invoices/${invoiceId}/status`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "200": () => Effect.void,
      orElse: unexpectedStatus
    }))
  ),
    "addLimitedUsers": (workspaceId, options) => HttpClientRequest.post(`/v1/workspaces/${workspaceId}/limited-users`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      orElse: unexpectedStatus
    }))
  ),
    "getMemberProfile": (workspaceId, userId, options) => HttpClientRequest.get(`/v1/workspaces/${workspaceId}/member-profile/${userId}`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetMemberProfile200),
      orElse: unexpectedStatus
    }))
  ),
    "updateMemberProfileWithAdditionalData": (workspaceId, userId, options) => HttpClientRequest.patch(`/v1/workspaces/${workspaceId}/member-profile/${userId}`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(UpdateMemberProfileWithAdditionalData200),
      orElse: unexpectedStatus
    }))
  ),
    "getProjects": (workspaceId, options) => HttpClientRequest.get(`/v1/workspaces/${workspaceId}/projects`).pipe(
    HttpClientRequest.setUrlParams({ "name": options?.params?.["name"] as any, "strict-name-search": options?.params?.["strict-name-search"] as any, "archived": options?.params?.["archived"] as any, "billable": options?.params?.["billable"] as any, "clients": options?.params?.["clients"] as any, "contains-client": options?.params?.["contains-client"] as any, "client-status": options?.params?.["client-status"] as any, "users": options?.params?.["users"] as any, "contains-user": options?.params?.["contains-user"] as any, "user-status": options?.params?.["user-status"] as any, "is-template": options?.params?.["is-template"] as any, "sort-column": options?.params?.["sort-column"] as any, "sort-order": options?.params?.["sort-order"] as any, "hydrated": options?.params?.["hydrated"] as any, "page": options?.params?.["page"] as any, "page-size": options?.params?.["page-size"] as any, "access": options?.params?.["access"] as any, "expense-limit": options?.params?.["expense-limit"] as any, "expense-date": options?.params?.["expense-date"] as any, "userGroups": options?.params?.["userGroups"] as any, "contains-group": options?.params?.["contains-group"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetProjects200),
      orElse: unexpectedStatus
    }))
  ),
    "createNewProject": (workspaceId, options) => HttpClientRequest.post(`/v1/workspaces/${workspaceId}/projects`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(CreateNewProject201),
      orElse: unexpectedStatus
    }))
  ),
    "createProjectFromTemplate": (workspaceId, options) => HttpClientRequest.post(`/v1/workspaces/${workspaceId}/projects/from-template`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(CreateProjectFromTemplate200),
      orElse: unexpectedStatus
    }))
  ),
    "getProject": (workspaceId, projectId, options) => HttpClientRequest.get(`/v1/workspaces/${workspaceId}/projects/${projectId}`).pipe(
    HttpClientRequest.setUrlParams({ "hydrated": options?.params?.["hydrated"] as any, "custom-field-entity-type": options?.params?.["custom-field-entity-type"] as any, "expense-limit": options?.params?.["expense-limit"] as any, "expense-date": options?.params?.["expense-date"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetProject200),
      orElse: unexpectedStatus
    }))
  ),
    "updateProject": (workspaceId, projectId, options) => HttpClientRequest.put(`/v1/workspaces/${workspaceId}/projects/${projectId}`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(UpdateProject200),
      orElse: unexpectedStatus
    }))
  ),
    "deleteProject": (workspaceId, projectId, options) => HttpClientRequest.delete(`/v1/workspaces/${workspaceId}/projects/${projectId}`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(DeleteProject200),
      orElse: unexpectedStatus
    }))
  ),
    "getCustomFieldsOfProject": (workspaceId, projectId, options) => HttpClientRequest.get(`/v1/workspaces/${workspaceId}/projects/${projectId}/custom-fields`).pipe(
    HttpClientRequest.setUrlParams({ "status": options?.params?.["status"] as any, "entity-type": options?.params?.["entity-type"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetCustomFieldsOfProject200),
      orElse: unexpectedStatus
    }))
  ),
    "removeDefaultValueOfProject": (workspaceId, projectId, customFieldId, options) => HttpClientRequest.delete(`/v1/workspaces/${workspaceId}/projects/${projectId}/custom-fields/${customFieldId}`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(RemoveDefaultValueOfProject200),
      orElse: unexpectedStatus
    }))
  ),
    "editProjectCustomFieldDefaultValue": (workspaceId, projectId, customFieldId, options) => HttpClientRequest.patch(`/v1/workspaces/${workspaceId}/projects/${projectId}/custom-fields/${customFieldId}`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(EditProjectCustomFieldDefaultValue200),
      orElse: unexpectedStatus
    }))
  ),
    "updateEstimate": (workspaceId, projectId, options) => HttpClientRequest.patch(`/v1/workspaces/${workspaceId}/projects/${projectId}/estimate`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(UpdateEstimate200),
      orElse: unexpectedStatus
    }))
  ),
    "addUsersToProject": (workspaceId, projectId, options) => HttpClientRequest.post(`/v1/workspaces/${workspaceId}/projects/${projectId}/memberships`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      orElse: unexpectedStatus
    }))
  ),
    "updateMemberships": (workspaceId, projectId, options) => HttpClientRequest.patch(`/v1/workspaces/${workspaceId}/projects/${projectId}/memberships`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(UpdateMemberships200),
      orElse: unexpectedStatus
    }))
  ),
    "getTasks": (workspaceId, projectId, options) => HttpClientRequest.get(`/v1/workspaces/${workspaceId}/projects/${projectId}/tasks`).pipe(
    HttpClientRequest.setUrlParams({ "name": options?.params?.["name"] as any, "strict-name-search": options?.params?.["strict-name-search"] as any, "is-active": options?.params?.["is-active"] as any, "page": options?.params?.["page"] as any, "page-size": options?.params?.["page-size"] as any, "sort-column": options?.params?.["sort-column"] as any, "sort-order": options?.params?.["sort-order"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetTasks200),
      orElse: unexpectedStatus
    }))
  ),
    "createTask": (workspaceId, projectId, options) => HttpClientRequest.post(`/v1/workspaces/${workspaceId}/projects/${projectId}/tasks`).pipe(
    HttpClientRequest.setUrlParams({ "contains-assignee": options.params?.["contains-assignee"] as any }),
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(CreateTask201),
      orElse: unexpectedStatus
    }))
  ),
    "setTaskCostRate": (workspaceId, projectId, id, options) => HttpClientRequest.put(`/v1/workspaces/${workspaceId}/projects/${projectId}/tasks/${id}/cost-rate`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(SetTaskCostRate200),
      orElse: unexpectedStatus
    }))
  ),
    "setTaskHourlyRate": (workspaceId, projectId, id, options) => HttpClientRequest.put(`/v1/workspaces/${workspaceId}/projects/${projectId}/tasks/${id}/hourly-rate`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(SetTaskHourlyRate200),
      orElse: unexpectedStatus
    }))
  ),
    "getTask": (workspaceId, projectId, taskId, options) => HttpClientRequest.get(`/v1/workspaces/${workspaceId}/projects/${projectId}/tasks/${taskId}`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetTask200),
      orElse: unexpectedStatus
    }))
  ),
    "updateTask": (workspaceId, projectId, taskId, options) => HttpClientRequest.put(`/v1/workspaces/${workspaceId}/projects/${projectId}/tasks/${taskId}`).pipe(
    HttpClientRequest.setUrlParams({ "contains-assignee": options.params?.["contains-assignee"] as any, "membership-status": options.params?.["membership-status"] as any }),
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(UpdateTask200),
      orElse: unexpectedStatus
    }))
  ),
    "deleteTask": (workspaceId, projectId, taskId, options) => HttpClientRequest.delete(`/v1/workspaces/${workspaceId}/projects/${projectId}/tasks/${taskId}`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(DeleteTask200),
      orElse: unexpectedStatus
    }))
  ),
    "updateIsProjectTemplate": (workspaceId, projectId, options) => HttpClientRequest.patch(`/v1/workspaces/${workspaceId}/projects/${projectId}/template`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(UpdateIsProjectTemplate200),
      orElse: unexpectedStatus
    }))
  ),
    "addUsersCostRate": (workspaceId, projectId, userId, options) => HttpClientRequest.put(`/v1/workspaces/${workspaceId}/projects/${projectId}/users/${userId}/cost-rate`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(AddUsersCostRate200),
      orElse: unexpectedStatus
    }))
  ),
    "addUsersHourlyRate": (workspaceId, projectId, userId, options) => HttpClientRequest.put(`/v1/workspaces/${workspaceId}/projects/${projectId}/users/${userId}/hourly-rate`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(AddUsersHourlyRate200),
      orElse: unexpectedStatus
    }))
  ),
    "getAllAssignments": (workspaceId, options) => HttpClientRequest.get(`/v1/workspaces/${workspaceId}/scheduling/assignments/all`).pipe(
    HttpClientRequest.setUrlParams({ "name": options.params["name"] as any, "start": options.params["start"] as any, "end": options.params["end"] as any, "sort-column": options.params["sort-column"] as any, "sort-order": options.params["sort-order"] as any, "page": options.params["page"] as any, "page-size": options.params["page-size"] as any }),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetAllAssignments200),
      orElse: unexpectedStatus
    }))
  ),
    "getProjectTotals": (workspaceId, options) => HttpClientRequest.get(`/v1/workspaces/${workspaceId}/scheduling/assignments/projects/totals`).pipe(
    HttpClientRequest.setUrlParams({ "search": options.params["search"] as any, "start": options.params["start"] as any, "end": options.params["end"] as any, "page": options.params["page"] as any, "page-size": options.params["page-size"] as any }),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetProjectTotals200),
      orElse: unexpectedStatus
    }))
  ),
    "getFilteredProjectTotals": (workspaceId, options) => HttpClientRequest.post(`/v1/workspaces/${workspaceId}/scheduling/assignments/projects/totals`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetFilteredProjectTotals200),
      orElse: unexpectedStatus
    }))
  ),
    "getProjectTotalsForSingleProject": (workspaceId, projectId, options) => HttpClientRequest.get(`/v1/workspaces/${workspaceId}/scheduling/assignments/projects/totals/${projectId}`).pipe(
    HttpClientRequest.setUrlParams({ "start": options.params["start"] as any, "end": options.params["end"] as any }),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetProjectTotalsForSingleProject200),
      orElse: unexpectedStatus
    }))
  ),
    "publishAssignments": (workspaceId, options) => HttpClientRequest.put(`/v1/workspaces/${workspaceId}/scheduling/assignments/publish`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "200": () => Effect.void,
      orElse: unexpectedStatus
    }))
  ),
    "createRecurring": (workspaceId, options) => HttpClientRequest.post(`/v1/workspaces/${workspaceId}/scheduling/assignments/recurring`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(CreateRecurring201),
      orElse: unexpectedStatus
    }))
  ),
    "deleteRRecurringAssignment": (workspaceId, assignmentId, options) => HttpClientRequest.delete(`/v1/workspaces/${workspaceId}/scheduling/assignments/recurring/${assignmentId}`).pipe(
    HttpClientRequest.setUrlParams({ "seriesUpdateOption": options?.params?.["seriesUpdateOption"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(DeleteRRecurringAssignment200),
      orElse: unexpectedStatus
    }))
  ),
    "editRecurring": (workspaceId, assignmentId, options) => HttpClientRequest.patch(`/v1/workspaces/${workspaceId}/scheduling/assignments/recurring/${assignmentId}`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(EditRecurring200),
      orElse: unexpectedStatus
    }))
  ),
    "editRecurringPeriod": (workspaceId, assignmentId, options) => HttpClientRequest.put(`/v1/workspaces/${workspaceId}/scheduling/assignments/series/${assignmentId}`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(EditRecurringPeriod200),
      orElse: unexpectedStatus
    }))
  ),
    "getUserTotals": (workspaceId, options) => HttpClientRequest.post(`/v1/workspaces/${workspaceId}/scheduling/assignments/user-filter/totals`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetUserTotals200),
      orElse: unexpectedStatus
    }))
  ),
    "getUserTotalsForSingleUser": (workspaceId, userId, options) => HttpClientRequest.get(`/v1/workspaces/${workspaceId}/scheduling/assignments/users/${userId}/totals`).pipe(
    HttpClientRequest.setUrlParams({ "page": options.params["page"] as any, "page-size": options.params["page-size"] as any, "start": options.params["start"] as any, "end": options.params["end"] as any }),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetUserTotalsForSingleUser200),
      orElse: unexpectedStatus
    }))
  ),
    "copyAssignment": (workspaceId, assignmentId, options) => HttpClientRequest.post(`/v1/workspaces/${workspaceId}/scheduling/assignments/${assignmentId}/copy`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(CopyAssignment200),
      orElse: unexpectedStatus
    }))
  ),
    "getTags": (workspaceId, options) => HttpClientRequest.get(`/v1/workspaces/${workspaceId}/tags`).pipe(
    HttpClientRequest.setUrlParams({ "name": options?.params?.["name"] as any, "strict-name-search": options?.params?.["strict-name-search"] as any, "excluded-ids": options?.params?.["excluded-ids"] as any, "sort-column": options?.params?.["sort-column"] as any, "sort-order": options?.params?.["sort-order"] as any, "page": options?.params?.["page"] as any, "page-size": options?.params?.["page-size"] as any, "archived": options?.params?.["archived"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetTags200),
      orElse: unexpectedStatus
    }))
  ),
    "createNewTag": (workspaceId, options) => HttpClientRequest.post(`/v1/workspaces/${workspaceId}/tags`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(CreateNewTag201),
      orElse: unexpectedStatus
    }))
  ),
    "getTag": (workspaceId, id, options) => HttpClientRequest.get(`/v1/workspaces/${workspaceId}/tags/${id}`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetTag200),
      orElse: unexpectedStatus
    }))
  ),
    "updateTag": (workspaceId, id, options) => HttpClientRequest.put(`/v1/workspaces/${workspaceId}/tags/${id}`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(UpdateTag200),
      orElse: unexpectedStatus
    }))
  ),
    "deleteTag": (workspaceId, id, options) => HttpClientRequest.delete(`/v1/workspaces/${workspaceId}/tags/${id}`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(DeleteTag200),
      orElse: unexpectedStatus
    }))
  ),
    "getTemplates": (workspaceId, options) => HttpClientRequest.get(`/v1/workspaces/${workspaceId}/templates`).pipe(
    HttpClientRequest.setUrlParams({ "name": options?.params?.["name"] as any, "cleansed": options?.params?.["cleansed"] as any, "hydrated": options?.params?.["hydrated"] as any, "page": options?.params?.["page"] as any, "page-size": options?.params?.["page-size"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetTemplates200),
      orElse: unexpectedStatus
    }))
  ),
    "createMany": (workspaceId, options) => HttpClientRequest.post(`/v1/workspaces/${workspaceId}/templates`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(CreateMany200),
      orElse: unexpectedStatus
    }))
  ),
    "getTemplate": (workspaceId, templateId, options) => HttpClientRequest.get(`/v1/workspaces/${workspaceId}/templates/${templateId}`).pipe(
    HttpClientRequest.setUrlParams({ "cleansed": options?.params?.["cleansed"] as any, "hydrated": options?.params?.["hydrated"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetTemplate200),
      orElse: unexpectedStatus
    }))
  ),
    "delete1": (workspaceId, templateId, options) => HttpClientRequest.delete(`/v1/workspaces/${workspaceId}/templates/${templateId}`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(Delete1200),
      orElse: unexpectedStatus
    }))
  ),
    "update": (workspaceId, templateId, options) => HttpClientRequest.patch(`/v1/workspaces/${workspaceId}/templates/${templateId}`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(Update200),
      orElse: unexpectedStatus
    }))
  ),
    "createTimeEntry": (workspaceId, options) => HttpClientRequest.post(`/v1/workspaces/${workspaceId}/time-entries`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(CreateTimeEntry201),
      orElse: unexpectedStatus
    }))
  ),
    "updateInvoicedStatus": (workspaceId, options) => HttpClientRequest.patch(`/v1/workspaces/${workspaceId}/time-entries/invoiced`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "200": () => Effect.void,
      orElse: unexpectedStatus
    }))
  ),
    "getInProgressTimeEntries": (workspaceId, options) => HttpClientRequest.get(`/v1/workspaces/${workspaceId}/time-entries/status/in-progress`).pipe(
    HttpClientRequest.setUrlParams({ "page": options?.params?.["page"] as any, "page-size": options?.params?.["page-size"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      orElse: unexpectedStatus
    }))
  ),
    "getTimeEntry": (workspaceId, id, options) => HttpClientRequest.get(`/v1/workspaces/${workspaceId}/time-entries/${id}`).pipe(
    HttpClientRequest.setUrlParams({ "hydrated": options?.params?.["hydrated"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetTimeEntry200),
      orElse: unexpectedStatus
    }))
  ),
    "updateTimeEntry": (workspaceId, id, options) => HttpClientRequest.put(`/v1/workspaces/${workspaceId}/time-entries/${id}`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(UpdateTimeEntry200),
      orElse: unexpectedStatus
    }))
  ),
    "deleteTimeEntry": (workspaceId, id, options) => HttpClientRequest.delete(`/v1/workspaces/${workspaceId}/time-entries/${id}`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "204": () => Effect.void,
      orElse: unexpectedStatus
    }))
  ),
    "getBalancesForPolicy": (workspaceId, policyId, options) => HttpClientRequest.get(`/v1/workspaces/${workspaceId}/time-off/balance/policy/${policyId}`).pipe(
    HttpClientRequest.setUrlParams({ "page": options?.params?.["page"] as any, "page-size": options?.params?.["page-size"] as any, "sort": options?.params?.["sort"] as any, "sort-order": options?.params?.["sort-order"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      orElse: unexpectedStatus
    }))
  ),
    "updateBalance": (workspaceId, policyId, options) => HttpClientRequest.patch(`/v1/workspaces/${workspaceId}/time-off/balance/policy/${policyId}`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "204": () => Effect.void,
      orElse: unexpectedStatus
    }))
  ),
    "getBalancesForUser": (workspaceId, userId, options) => HttpClientRequest.get(`/v1/workspaces/${workspaceId}/time-off/balance/user/${userId}`).pipe(
    HttpClientRequest.setUrlParams({ "page": options?.params?.["page"] as any, "page-size": options?.params?.["page-size"] as any, "sort": options?.params?.["sort"] as any, "sort-order": options?.params?.["sort-order"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      orElse: unexpectedStatus
    }))
  ),
    "findPoliciesForWorkspace": (workspaceId, options) => HttpClientRequest.get(`/v1/workspaces/${workspaceId}/time-off/policies`).pipe(
    HttpClientRequest.setUrlParams({ "page": options?.params?.["page"] as any, "page-size": options?.params?.["page-size"] as any, "name": options?.params?.["name"] as any, "status": options?.params?.["status"] as any, "sort-column": options?.params?.["sort-column"] as any, "sort-order": options?.params?.["sort-order"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(FindPoliciesForWorkspace200),
      orElse: unexpectedStatus
    }))
  ),
    "createPolicy": (workspaceId, options) => HttpClientRequest.post(`/v1/workspaces/${workspaceId}/time-off/policies`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(CreatePolicy201),
      orElse: unexpectedStatus
    }))
  ),
    "getPolicy": (workspaceId, id, options) => HttpClientRequest.get(`/v1/workspaces/${workspaceId}/time-off/policies/${id}`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetPolicy200),
      orElse: unexpectedStatus
    }))
  ),
    "updatePolicy": (workspaceId, id, options) => HttpClientRequest.put(`/v1/workspaces/${workspaceId}/time-off/policies/${id}`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(UpdatePolicy200),
      orElse: unexpectedStatus
    }))
  ),
    "deletePolicy": (workspaceId, id, options) => HttpClientRequest.delete(`/v1/workspaces/${workspaceId}/time-off/policies/${id}`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "200": () => Effect.void,
      orElse: unexpectedStatus
    }))
  ),
    "updatePolicyStatus": (workspaceId, id, options) => HttpClientRequest.patch(`/v1/workspaces/${workspaceId}/time-off/policies/${id}`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(UpdatePolicyStatus200),
      orElse: unexpectedStatus
    }))
  ),
    "createTimeOffRequest": (workspaceId, policyId, options) => HttpClientRequest.post(`/v1/workspaces/${workspaceId}/time-off/policies/${policyId}/requests`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(CreateTimeOffRequest200),
      orElse: unexpectedStatus
    }))
  ),
    "deleteTimeOffRequest": (workspaceId, policyId, requestId, options) => HttpClientRequest.delete(`/v1/workspaces/${workspaceId}/time-off/policies/${policyId}/requests/${requestId}`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(DeleteTimeOffRequest200),
      orElse: unexpectedStatus
    }))
  ),
    "changeTimeOffRequestStatus": (workspaceId, policyId, requestId, options) => HttpClientRequest.patch(`/v1/workspaces/${workspaceId}/time-off/policies/${policyId}/requests/${requestId}`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(ChangeTimeOffRequestStatus200),
      orElse: unexpectedStatus
    }))
  ),
    "createTimeOffRequestForOther": (workspaceId, policyId, userId, options) => HttpClientRequest.post(`/v1/workspaces/${workspaceId}/time-off/policies/${policyId}/users/${userId}/requests`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(CreateTimeOffRequestForOther200),
      orElse: unexpectedStatus
    }))
  ),
    "getTimeOffRequest": (workspaceId, options) => HttpClientRequest.post(`/v1/workspaces/${workspaceId}/time-off/requests`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetTimeOffRequest200),
      orElse: unexpectedStatus
    }))
  ),
    "getUserGroups": (workspaceId, options) => HttpClientRequest.get(`/v1/workspaces/${workspaceId}/user-groups`).pipe(
    HttpClientRequest.setUrlParams({ "project-id": options?.params?.["project-id"] as any, "name": options?.params?.["name"] as any, "sort-column": options?.params?.["sort-column"] as any, "sort-order": options?.params?.["sort-order"] as any, "page": options?.params?.["page"] as any, "page-size": options?.params?.["page-size"] as any, "includeTeamManagers": options?.params?.["includeTeamManagers"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetUserGroups200),
      orElse: unexpectedStatus
    }))
  ),
    "createUserGroup": (workspaceId, options) => HttpClientRequest.post(`/v1/workspaces/${workspaceId}/user-groups`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(CreateUserGroup201),
      orElse: unexpectedStatus
    }))
  ),
    "updateUserGroup": (workspaceId, id, options) => HttpClientRequest.put(`/v1/workspaces/${workspaceId}/user-groups/${id}`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(UpdateUserGroup200),
      orElse: unexpectedStatus
    }))
  ),
    "deleteUserGroup": (workspaceId, id, options) => HttpClientRequest.delete(`/v1/workspaces/${workspaceId}/user-groups/${id}`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(DeleteUserGroup200),
      orElse: unexpectedStatus
    }))
  ),
    "addUser": (workspaceId, userGroupId, options) => HttpClientRequest.post(`/v1/workspaces/${workspaceId}/user-groups/${userGroupId}/users`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(AddUser200),
      orElse: unexpectedStatus
    }))
  ),
    "deleteUser": (workspaceId, userGroupId, userId, options) => HttpClientRequest.delete(`/v1/workspaces/${workspaceId}/user-groups/${userGroupId}/users/${userId}`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(DeleteUser200),
      orElse: unexpectedStatus
    }))
  ),
    "getTimeEntries": (workspaceId, userId, options) => HttpClientRequest.get(`/v1/workspaces/${workspaceId}/user/${userId}/time-entries`).pipe(
    HttpClientRequest.setUrlParams({ "description": options?.params?.["description"] as any, "start": options?.params?.["start"] as any, "end": options?.params?.["end"] as any, "project": options?.params?.["project"] as any, "task": options?.params?.["task"] as any, "tags": options?.params?.["tags"] as any, "project-required": options?.params?.["project-required"] as any, "task-required": options?.params?.["task-required"] as any, "hydrated": options?.params?.["hydrated"] as any, "page": options?.params?.["page"] as any, "page-size": options?.params?.["page-size"] as any, "in-progress": options?.params?.["in-progress"] as any, "get-week-before": options?.params?.["get-week-before"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetTimeEntries200),
      orElse: unexpectedStatus
    }))
  ),
    "replaceMany": (workspaceId, userId, options) => HttpClientRequest.put(`/v1/workspaces/${workspaceId}/user/${userId}/time-entries`).pipe(
    HttpClientRequest.setUrlParams({ "hydrated": options.params?.["hydrated"] as any }),
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(ReplaceMany200),
      orElse: unexpectedStatus
    }))
  ),
    "createForOthers": (workspaceId, userId, options) => HttpClientRequest.post(`/v1/workspaces/${workspaceId}/user/${userId}/time-entries`).pipe(
    HttpClientRequest.setUrlParams({ "from-entry": options.params?.["from-entry"] as any }),
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(CreateForOthers201),
      orElse: unexpectedStatus
    }))
  ),
    "deleteMany": (workspaceId, userId, options) => HttpClientRequest.delete(`/v1/workspaces/${workspaceId}/user/${userId}/time-entries`).pipe(
    HttpClientRequest.setUrlParams({ "time-entry-ids": options.params["time-entry-ids"] as any }),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(DeleteMany200),
      orElse: unexpectedStatus
    }))
  ),
    "stopRunningTimeEntry": (workspaceId, userId, options) => HttpClientRequest.patch(`/v1/workspaces/${workspaceId}/user/${userId}/time-entries`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(StopRunningTimeEntry200),
      orElse: unexpectedStatus
    }))
  ),
    "duplicateTimeEntry": (workspaceId, userId, id, options) => HttpClientRequest.post(`/v1/workspaces/${workspaceId}/user/${userId}/time-entries/${id}/duplicate`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(DuplicateTimeEntry201),
      orElse: unexpectedStatus
    }))
  ),
    "getUsersOfWorkspace": (workspaceId, options) => HttpClientRequest.get(`/v1/workspaces/${workspaceId}/users`).pipe(
    HttpClientRequest.setUrlParams({ "email": options.params["email"] as any, "project-id": options.params["project-id"] as any, "status": options.params["status"] as any, "account-statuses": options.params["account-statuses"] as any, "name": options.params["name"] as any, "sort-column": options.params["sort-column"] as any, "sort-order": options.params["sort-order"] as any, "page": options.params["page"] as any, "page-size": options.params["page-size"] as any, "memberships": options.params["memberships"] as any, "include-roles": options.params["include-roles"] as any }),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetUsersOfWorkspace200),
      orElse: unexpectedStatus
    }))
  ),
    "addUsers": (workspaceId, options) => HttpClientRequest.post(`/v1/workspaces/${workspaceId}/users`).pipe(
    HttpClientRequest.setUrlParams({ "send-email": options.params["send-email"] as any }),
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(AddUsers200),
      orElse: unexpectedStatus
    }))
  ),
    "filterUsersOfWorkspace": (workspaceId, options) => HttpClientRequest.post(`/v1/workspaces/${workspaceId}/users/info`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(FilterUsersOfWorkspace200),
      orElse: unexpectedStatus
    }))
  ),
    "updateUserStatus": (workspaceId, userId, options) => HttpClientRequest.put(`/v1/workspaces/${workspaceId}/users/${userId}`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(UpdateUserStatus200),
      orElse: unexpectedStatus
    }))
  ),
    "removeMember": (workspaceId, userId, options) => HttpClientRequest.delete(`/v1/workspaces/${workspaceId}/users/${userId}`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(RemoveMember200),
      orElse: unexpectedStatus
    }))
  ),
    "setCostRateForUser": (workspaceId, userId, options) => HttpClientRequest.put(`/v1/workspaces/${workspaceId}/users/${userId}/cost-rate`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(SetCostRateForUser200),
      orElse: unexpectedStatus
    }))
  ),
    "upsertUserCustomFieldValue": (workspaceId, userId, customFieldId, options) => HttpClientRequest.put(`/v1/workspaces/${workspaceId}/users/${userId}/custom-field/${customFieldId}/value`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(UpsertUserCustomFieldValue201),
      orElse: unexpectedStatus
    }))
  ),
    "setHourlyRateForUser": (workspaceId, userId, options) => HttpClientRequest.put(`/v1/workspaces/${workspaceId}/users/${userId}/hourly-rate`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(SetHourlyRateForUser200),
      orElse: unexpectedStatus
    }))
  ),
    "getManagersOfUser": (workspaceId, userId, options) => HttpClientRequest.get(`/v1/workspaces/${workspaceId}/users/${userId}/managers`).pipe(
    HttpClientRequest.setUrlParams({ "sort-column": options?.params?.["sort-column"] as any, "sort-order": options?.params?.["sort-order"] as any, "page": options?.params?.["page"] as any, "page-size": options?.params?.["page-size"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetManagersOfUser200),
      orElse: unexpectedStatus
    }))
  ),
    "createUserRole": (workspaceId, userId, options) => HttpClientRequest.post(`/v1/workspaces/${workspaceId}/users/${userId}/roles`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(CreateUserRole201),
      orElse: unexpectedStatus
    }))
  ),
    "deleteUserRole": (workspaceId, userId, options) => HttpClientRequest.delete(`/v1/workspaces/${workspaceId}/users/${userId}/roles`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "204": () => Effect.void,
      orElse: unexpectedStatus
    }))
  ),
    "getWebhooks": (workspaceId, options) => HttpClientRequest.get(`/v1/workspaces/${workspaceId}/webhooks`).pipe(
    HttpClientRequest.setUrlParams({ "type": options?.params?.["type"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetWebhooks200),
      orElse: unexpectedStatus
    }))
  ),
    "createWebhook": (workspaceId, options) => HttpClientRequest.post(`/v1/workspaces/${workspaceId}/webhooks`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(CreateWebhook201),
      orElse: unexpectedStatus
    }))
  ),
    "getWebhook": (workspaceId, webhookId, options) => HttpClientRequest.get(`/v1/workspaces/${workspaceId}/webhooks/${webhookId}`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetWebhook200),
      orElse: unexpectedStatus
    }))
  ),
    "updateWebhook": (workspaceId, webhookId, options) => HttpClientRequest.put(`/v1/workspaces/${workspaceId}/webhooks/${webhookId}`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(UpdateWebhook200),
      orElse: unexpectedStatus
    }))
  ),
    "deleteWebhook": (workspaceId, webhookId, options) => HttpClientRequest.delete(`/v1/workspaces/${workspaceId}/webhooks/${webhookId}`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "200": () => Effect.void,
      orElse: unexpectedStatus
    }))
  ),
    "getLogsForWebhook": (workspaceId, webhookId, options) => HttpClientRequest.post(`/v1/workspaces/${workspaceId}/webhooks/${webhookId}/logs`).pipe(
    HttpClientRequest.setUrlParams({ "page": options.params?.["page"] as any, "size": options.params?.["size"] as any }),
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetLogsForWebhook200),
      orElse: unexpectedStatus
    }))
  ),
    "getWebhookEventStatusesWithLatestLog": (workspaceId, webhookId, options) => HttpClientRequest.get(`/v1/workspaces/${workspaceId}/webhooks/${webhookId}/statuses`).pipe(
    HttpClientRequest.setUrlParams({ "page": options?.params?.["page"] as any, "size": options?.params?.["size"] as any, "statuses": options?.params?.["statuses"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetWebhookEventStatusesWithLatestLog200),
      orElse: unexpectedStatus
    }))
  ),
    "generateNewToken": (workspaceId, webhookId, options) => HttpClientRequest.patch(`/v1/workspaces/${workspaceId}/webhooks/${webhookId}/token`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GenerateNewToken200),
      orElse: unexpectedStatus
    }))
  ),
    "generateSharedReportV1": (id, options) => HttpClientRequest.get(`/v1/shared-reports/${id}`).pipe(
    HttpClientRequest.setUrlParams({ "dateRangeStart": options?.params?.["dateRangeStart"] as any, "dateRangeEnd": options?.params?.["dateRangeEnd"] as any, "sortOrder": options?.params?.["sortOrder"] as any, "sortColumn": options?.params?.["sortColumn"] as any, "exportType": options?.params?.["exportType"] as any, "page": options?.params?.["page"] as any, "pageSize": options?.params?.["pageSize"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      orElse: unexpectedStatus
    }))
  ),
    "generateAttendanceReport": (workspaceId, options) => HttpClientRequest.post(`/v1/workspaces/${workspaceId}/reports/attendance`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      orElse: unexpectedStatus
    }))
  ),
    "generateDetailedReport": (workspaceId, options) => HttpClientRequest.post(`/v1/workspaces/${workspaceId}/reports/detailed`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      orElse: unexpectedStatus
    }))
  ),
    "generateDetailedReportV1": (workspaceId, options) => HttpClientRequest.post(`/v1/workspaces/${workspaceId}/reports/expenses/detailed`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GenerateDetailedReportV1200),
      orElse: unexpectedStatus
    }))
  ),
    "generateSummaryReport": (workspaceId, options) => HttpClientRequest.post(`/v1/workspaces/${workspaceId}/reports/summary`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      orElse: unexpectedStatus
    }))
  ),
    "generateWeeklyReport": (workspaceId, options) => HttpClientRequest.post(`/v1/workspaces/${workspaceId}/reports/weekly`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      orElse: unexpectedStatus
    }))
  ),
    "getSharedReportsV1": (workspaceId, options) => HttpClientRequest.get(`/v1/workspaces/${workspaceId}/shared-reports`).pipe(
    HttpClientRequest.setUrlParams({ "page": options?.params?.["page"] as any, "pageSize": options?.params?.["pageSize"] as any, "sharedReportsFilter": options?.params?.["sharedReportsFilter"] as any }),
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      orElse: unexpectedStatus
    }))
  ),
    "saveSharedReportV1": (workspaceId, options) => HttpClientRequest.post(`/v1/workspaces/${workspaceId}/shared-reports`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      orElse: unexpectedStatus
    }))
  ),
    "updateSharedReportV1": (workspaceId, id, options) => HttpClientRequest.put(`/v1/workspaces/${workspaceId}/shared-reports/${id}`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      orElse: unexpectedStatus
    }))
  ),
    "deleteSharedReportV1": (workspaceId, id, options) => HttpClientRequest.delete(`/v1/workspaces/${workspaceId}/shared-reports/${id}`).pipe(
    withResponse(options?.config)(HttpClientResponse.matchStatus({
      "204": () => Effect.void,
      orElse: unexpectedStatus
    }))
  ),
    "getAuditLogs": (workspaceId, options) => HttpClientRequest.post(`/v1/workspaces/${workspaceId}/audit-log`).pipe(
    HttpClientRequest.bodyJsonUnsafe(options.payload),
    withResponse(options.config)(HttpClientResponse.matchStatus({
      "2xx": decodeSuccess(GetAuditLogs200),
      orElse: unexpectedStatus
    }))
  )
  }
}

export interface ClockifyApi {
  readonly httpClient: HttpClient.HttpClient
  /**
* Add a photo
*/
readonly "uploadImage": <Config extends OperationConfig>(options: { readonly payload: typeof UploadImageRequestFormData.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof UploadImage200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Get currently logged-in user's info
*/
readonly "getLoggedUser": <Config extends OperationConfig>(options: { readonly params?: typeof GetLoggedUserParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetLoggedUser200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Get all my workspaces
*/
readonly "getWorkspacesOfUser": <Config extends OperationConfig>(options: { readonly params?: typeof GetWorkspacesOfUserParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetWorkspacesOfUser200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Add a workspace
*/
readonly "createWorkspace": <Config extends OperationConfig>(options: { readonly payload: typeof CreateWorkspaceRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof CreateWorkspace201.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Get workspace info
*/
readonly "getWorkspaceOfUser": <Config extends OperationConfig>(workspaceId: string, options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetWorkspaceOfUser200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Get all webhooks for addon on a workspace
*/
readonly "getAddonWebhooks": <Config extends OperationConfig>(workspaceId: string, addonId: string, options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetAddonWebhooks200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Get approval requests
*/
readonly "getApprovalRequests": <Config extends OperationConfig>(workspaceId: string, options: { readonly params?: typeof GetApprovalRequestsParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetApprovalRequests200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Submit approval request
*/
readonly "createApprrovalRequest": <Config extends OperationConfig>(workspaceId: string, options: { readonly payload: typeof CreateApprrovalRequestRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof CreateApprrovalRequest201.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Submit non pending/approved entries/expenses for approval to an existing approval request
*/
readonly "resubmitApprovalRequest": <Config extends OperationConfig>(workspaceId: string, options: { readonly payload: typeof ResubmitApprovalRequestRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<void, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Submit an approval request for a user
*/
readonly "createApprovalForOther": <Config extends OperationConfig>(workspaceId: string, userId: string, options: { readonly payload: typeof CreateApprovalForOtherRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof CreateApprovalForOther201.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Re-submit rejected/withdrawn entries/expenses for an approval of a user
*/
readonly "resubmitApprovalRequestForOther": <Config extends OperationConfig>(workspaceId: string, userId: string, options: { readonly payload: typeof ResubmitApprovalRequestForOtherRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<void, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Update an approval request
*/
readonly "updateApprovalStatus": <Config extends OperationConfig>(workspaceId: string, approvalRequestId: string, options: { readonly payload: typeof UpdateApprovalStatusRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof UpdateApprovalStatus200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Find clients on a workspace
*/
readonly "getClients": <Config extends OperationConfig>(workspaceId: string, options: { readonly params?: typeof GetClientsParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetClients200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Add a new client
*/
readonly "createClient": <Config extends OperationConfig>(workspaceId: string, options: { readonly payload: typeof CreateClientRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof CreateClient201.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Get a client by ID
*/
readonly "getClient": <Config extends OperationConfig>(workspaceId: string, id: string, options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetClient200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Update a client
*/
readonly "updateClient": <Config extends OperationConfig>(workspaceId: string, id: string, options: { readonly params?: typeof UpdateClientParams.Encoded | undefined; readonly payload: typeof UpdateClientRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof UpdateClient200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Delete a client
*/
readonly "deleteClient": <Config extends OperationConfig>(workspaceId: string, id: string, options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof DeleteClient200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Update workspace cost rate
*/
readonly "setWorkspaceCostRate": <Config extends OperationConfig>(workspaceId: string, options: { readonly payload: typeof SetWorkspaceCostRateRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof SetWorkspaceCostRate200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Get custom fields on a workspace
*/
readonly "ofWorkspace": <Config extends OperationConfig>(workspaceId: string, options: { readonly params?: typeof OfWorkspaceParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof OfWorkspace200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Create custom fields on a workspace
*/
readonly "create": <Config extends OperationConfig>(workspaceId: string, options: { readonly payload: typeof CreateRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<void, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Update custom field on workspace
*/
readonly "editCustomField": <Config extends OperationConfig>(workspaceId: string, customFieldId: string, options: { readonly payload: typeof EditCustomFieldRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof EditCustomField200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Delete a custom field
*/
readonly "delete": <Config extends OperationConfig>(workspaceId: string, customFieldId: string, options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<void, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Retrieves records from the database collection that were created within a specified date range.
* The date range is determined by two parameters: start and end.
*/
readonly "getCreatedEntityInfo": <Config extends OperationConfig>(workspaceId: string, options: { readonly params: typeof GetCreatedEntityInfoParams.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof GetCreatedEntityInfo200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Retrieves a list of record(s) that were deleted within a specified date range.
* The date range is determined by the two parameters start and end.
*
* > ### 💡 Note
* > Deleted entities will be updated and reflected in this endpoint approximately one minute after the deletion occurs. Also, entities that are created and deleted within the request date range will not appear in the /deleted endpoint.
*/
readonly "getDeletedEntityInfo": <Config extends OperationConfig>(workspaceId: string, options: { readonly params: typeof GetDeletedEntityInfoParams.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof GetDeletedEntityInfo200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Retrieves records that were updated within the specified date range.
* The date range is determined by the two parameters: start and end.
*
* > ### 💡 Note
* > If an entity is both created and updated within the requested date range, it will be excluded from the /updated endpoint results.
*/
readonly "getUpdatedEntityInfo": <Config extends OperationConfig>(workspaceId: string, options: { readonly params: typeof GetUpdatedEntityInfoParams.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof GetUpdatedEntityInfo200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Get all expenses on a workspace
*/
readonly "getExpenses": <Config extends OperationConfig>(workspaceId: string, options: { readonly params?: typeof GetExpensesParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetExpenses200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Create an expense
*/
readonly "createExpense": <Config extends OperationConfig>(workspaceId: string, options: { readonly payload: typeof CreateExpenseRequestFormData.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof CreateExpense201.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Get all expense categories
*/
readonly "getCategories": <Config extends OperationConfig>(workspaceId: string, options: { readonly params?: typeof GetCategoriesParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetCategories200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Add an expense category
*/
readonly "createExpenseCategory": <Config extends OperationConfig>(workspaceId: string, options: { readonly payload: typeof CreateExpenseCategoryRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof CreateExpenseCategory201.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Update an expense category
*/
readonly "updateCategory": <Config extends OperationConfig>(workspaceId: string, categoryId: string, options: { readonly payload: typeof UpdateCategoryRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof UpdateCategory200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Delete an expense category
*/
readonly "deleteCategory": <Config extends OperationConfig>(workspaceId: string, categoryId: string, options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<void, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Archive an expense category
*/
readonly "updateExpenseCategoryStatus": <Config extends OperationConfig>(workspaceId: string, categoryId: string, options: { readonly payload: typeof UpdateExpenseCategoryStatusRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof UpdateExpenseCategoryStatus200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Get an expense by ID
*/
readonly "getExpense": <Config extends OperationConfig>(workspaceId: string, expenseId: string, options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetExpense200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Update an expense
*/
readonly "updateExpense": <Config extends OperationConfig>(workspaceId: string, expenseId: string, options: { readonly payload: typeof UpdateExpenseRequestFormData.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof UpdateExpense200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Delete an expense
*/
readonly "deleteExpense": <Config extends OperationConfig>(workspaceId: string, expenseId: string, options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<void, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Download a receipt
*/
readonly "downloadFile": <Config extends OperationConfig>(workspaceId: string, expenseId: string, fileId: string, options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<void, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Get holidays on a workspace
*/
readonly "getHolidays": <Config extends OperationConfig>(workspaceId: string, options: { readonly params?: typeof GetHolidaysParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetHolidays200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Create a holiday
*/
readonly "createHoliday": <Config extends OperationConfig>(workspaceId: string, options: { readonly payload: typeof CreateHolidayRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof CreateHoliday200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Get holidays in a specific period
*/
readonly "getHolidaysInPeriod": <Config extends OperationConfig>(workspaceId: string, options: { readonly params: typeof GetHolidaysInPeriodParams.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof GetHolidaysInPeriod200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Update a holiday
*/
readonly "updateHoliday": <Config extends OperationConfig>(workspaceId: string, holidayId: string, options: { readonly payload: typeof UpdateHolidayRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof UpdateHoliday200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Delete a holiday
*/
readonly "deleteHoliday": <Config extends OperationConfig>(workspaceId: string, holidayId: string, options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof DeleteHoliday200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Update workspace billable rate
*/
readonly "setWorkspaceHourlyRate": <Config extends OperationConfig>(workspaceId: string, options: { readonly payload: typeof SetWorkspaceHourlyRateRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof SetWorkspaceHourlyRate200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Get all invoices on a workspace
*/
readonly "getInvoices": <Config extends OperationConfig>(workspaceId: string, options: { readonly params?: typeof GetInvoicesParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetInvoices200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Add an invoice
*/
readonly "createInvoice": <Config extends OperationConfig>(workspaceId: string, options: { readonly payload: typeof CreateInvoiceRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof CreateInvoice201.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Filter out invoices
*/
readonly "getInvoicesInfo": <Config extends OperationConfig>(workspaceId: string, options: { readonly payload: typeof GetInvoicesInfoRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof GetInvoicesInfo200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Get an invoice in another language
*/
readonly "getInvoiceSettings": <Config extends OperationConfig>(workspaceId: string, options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetInvoiceSettings200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Change an invoice language
*/
readonly "updateInvoiceSettings": <Config extends OperationConfig>(workspaceId: string, options: { readonly payload: typeof UpdateInvoiceSettingsRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<void, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Get an invoice by ID
*/
readonly "getInvoice": <Config extends OperationConfig>(workspaceId: string, invoiceId: string, options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetInvoice200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Update an invoice
*/
readonly "updateInvoice": <Config extends OperationConfig>(workspaceId: string, invoiceId: string, options: { readonly payload: typeof UpdateInvoiceRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof UpdateInvoice200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Delete an invoice
*/
readonly "deleteInvoice": <Config extends OperationConfig>(workspaceId: string, invoiceId: string, options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<void, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Duplicate an invoice
*/
readonly "duplicateInvoice": <Config extends OperationConfig>(workspaceId: string, invoiceId: string, options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof DuplicateInvoice201.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Export an invoice
*/
readonly "exportInvoice": <Config extends OperationConfig>(workspaceId: string, invoiceId: string, options: { readonly params: typeof ExportInvoiceParams.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<void, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Add item to an invoice
*/
readonly "addInvoiceItem": <Config extends OperationConfig>(workspaceId: string, invoiceId: string, options: { readonly payload: typeof AddInvoiceItemRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof AddInvoiceItem200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Import time entries and expenses to an invoice
*/
readonly "importTimeEntriesAndExpenses": <Config extends OperationConfig>(workspaceId: string, invoiceId: string, options: { readonly payload: typeof ImportTimeEntriesAndExpensesRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof ImportTimeEntriesAndExpenses200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Delete item from an invoice
*/
readonly "removeInvoiceItem": <Config extends OperationConfig>(workspaceId: string, invoiceId: string, order: string, options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof RemoveInvoiceItem200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Get payments for an invoice
*/
readonly "getPaymentsForInvoice": <Config extends OperationConfig>(workspaceId: string, invoiceId: string, options: { readonly params?: typeof GetPaymentsForInvoiceParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetPaymentsForInvoice200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Add payment to an invoice
*/
readonly "createInvoicePayment": <Config extends OperationConfig>(workspaceId: string, invoiceId: string, options: { readonly payload: typeof CreateInvoicePaymentRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof CreateInvoicePayment201.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Delete payment from an invoice
*/
readonly "deletePaymentById": <Config extends OperationConfig>(workspaceId: string, invoiceId: string, paymentId: string, options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof DeletePaymentById200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Change an invoice status
*/
readonly "changeInvoiceStatus": <Config extends OperationConfig>(workspaceId: string, invoiceId: string, options: { readonly payload: typeof ChangeInvoiceStatusRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<void, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Add limited users
*/
readonly "addLimitedUsers": <Config extends OperationConfig>(workspaceId: string, options: { readonly payload: typeof AddLimitedUsersRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<void, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Get a member's profile
*/
readonly "getMemberProfile": <Config extends OperationConfig>(workspaceId: string, userId: string, options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetMemberProfile200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Update a member's profile
*/
readonly "updateMemberProfileWithAdditionalData": <Config extends OperationConfig>(workspaceId: string, userId: string, options: { readonly payload: typeof UpdateMemberProfileWithAdditionalDataRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof UpdateMemberProfileWithAdditionalData200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Get all projects on a workspace
*/
readonly "getProjects": <Config extends OperationConfig>(workspaceId: string, options: { readonly params?: typeof GetProjectsParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetProjects200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Add a new project
*/
readonly "createNewProject": <Config extends OperationConfig>(workspaceId: string, options: { readonly payload: typeof CreateNewProjectRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof CreateNewProject201.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Create project from a template
*/
readonly "createProjectFromTemplate": <Config extends OperationConfig>(workspaceId: string, options: { readonly payload: typeof CreateProjectFromTemplateRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof CreateProjectFromTemplate200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Find a project by ID
*/
readonly "getProject": <Config extends OperationConfig>(workspaceId: string, projectId: string, options: { readonly params?: typeof GetProjectParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetProject200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Update a project on a workspace
*/
readonly "updateProject": <Config extends OperationConfig>(workspaceId: string, projectId: string, options: { readonly payload: typeof UpdateProjectRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof UpdateProject200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Delete a project from a workspace
*/
readonly "deleteProject": <Config extends OperationConfig>(workspaceId: string, projectId: string, options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof DeleteProject200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Get custom fields on a project
*/
readonly "getCustomFieldsOfProject": <Config extends OperationConfig>(workspaceId: string, projectId: string, options: { readonly params?: typeof GetCustomFieldsOfProjectParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetCustomFieldsOfProject200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Remove custom field from a project
*/
readonly "removeDefaultValueOfProject": <Config extends OperationConfig>(workspaceId: string, projectId: string, customFieldId: string, options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof RemoveDefaultValueOfProject200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Update custom field on a project
*/
readonly "editProjectCustomFieldDefaultValue": <Config extends OperationConfig>(workspaceId: string, projectId: string, customFieldId: string, options: { readonly payload: typeof EditProjectCustomFieldDefaultValueRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof EditProjectCustomFieldDefaultValue200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Update project estimate
*/
readonly "updateEstimate": <Config extends OperationConfig>(workspaceId: string, projectId: string, options: { readonly payload: typeof UpdateEstimateRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof UpdateEstimate200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Assign/remove users to/from the project
*/
readonly "addUsersToProject": <Config extends OperationConfig>(workspaceId: string, projectId: string, options: { readonly payload: typeof AddUsersToProjectRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<void, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Update project memberships
*/
readonly "updateMemberships": <Config extends OperationConfig>(workspaceId: string, projectId: string, options: { readonly payload: typeof UpdateMembershipsRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof UpdateMemberships200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Find tasks on a project
*/
readonly "getTasks": <Config extends OperationConfig>(workspaceId: string, projectId: string, options: { readonly params?: typeof GetTasksParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetTasks200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Add a new task on a project
*/
readonly "createTask": <Config extends OperationConfig>(workspaceId: string, projectId: string, options: { readonly params?: typeof CreateTaskParams.Encoded | undefined; readonly payload: typeof CreateTaskRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof CreateTask201.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Update a task's cost rate
*/
readonly "setTaskCostRate": <Config extends OperationConfig>(workspaceId: string, projectId: string, id: string, options: { readonly payload: typeof SetTaskCostRateRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof SetTaskCostRate200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Update a task's billable rate
*/
readonly "setTaskHourlyRate": <Config extends OperationConfig>(workspaceId: string, projectId: string, id: string, options: { readonly payload: typeof SetTaskHourlyRateRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof SetTaskHourlyRate200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Get a task by id
*/
readonly "getTask": <Config extends OperationConfig>(workspaceId: string, projectId: string, taskId: string, options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetTask200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Update a task on a project
*/
readonly "updateTask": <Config extends OperationConfig>(workspaceId: string, projectId: string, taskId: string, options: { readonly params?: typeof UpdateTaskParams.Encoded | undefined; readonly payload: typeof UpdateTaskRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof UpdateTask200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Delete a task from a project
*/
readonly "deleteTask": <Config extends OperationConfig>(workspaceId: string, projectId: string, taskId: string, options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof DeleteTask200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Update a project template
*/
readonly "updateIsProjectTemplate": <Config extends OperationConfig>(workspaceId: string, projectId: string, options: { readonly payload: typeof UpdateIsProjectTemplateRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof UpdateIsProjectTemplate200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Update project user's cost rate
*/
readonly "addUsersCostRate": <Config extends OperationConfig>(workspaceId: string, projectId: string, userId: string, options: { readonly payload: typeof AddUsersCostRateRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof AddUsersCostRate200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Update a project user's billable rate
*/
readonly "addUsersHourlyRate": <Config extends OperationConfig>(workspaceId: string, projectId: string, userId: string, options: { readonly payload: typeof AddUsersHourlyRateRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof AddUsersHourlyRate200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Get all assignments
*/
readonly "getAllAssignments": <Config extends OperationConfig>(workspaceId: string, options: { readonly params: typeof GetAllAssignmentsParams.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof GetAllAssignments200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Get all scheduled assignments per project
*/
readonly "getProjectTotals": <Config extends OperationConfig>(workspaceId: string, options: { readonly params: typeof GetProjectTotalsParams.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof GetProjectTotals200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Get all scheduled assignments per project
*/
readonly "getFilteredProjectTotals": <Config extends OperationConfig>(workspaceId: string, options: { readonly payload: typeof GetFilteredProjectTotalsRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof GetFilteredProjectTotals200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Get all scheduled assignments on project
*/
readonly "getProjectTotalsForSingleProject": <Config extends OperationConfig>(workspaceId: string, projectId: string, options: { readonly params: typeof GetProjectTotalsForSingleProjectParams.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof GetProjectTotalsForSingleProject200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Publish assignments
*/
readonly "publishAssignments": <Config extends OperationConfig>(workspaceId: string, options: { readonly payload: typeof PublishAssignmentsRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<void, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Create assignment
*/
readonly "createRecurring": <Config extends OperationConfig>(workspaceId: string, options: { readonly payload: typeof CreateRecurringRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof CreateRecurring201.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Delete assignment
*/
readonly "deleteRRecurringAssignment": <Config extends OperationConfig>(workspaceId: string, assignmentId: string, options: { readonly params?: typeof DeleteRRecurringAssignmentParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof DeleteRRecurringAssignment200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Update assignment
*/
readonly "editRecurring": <Config extends OperationConfig>(workspaceId: string, assignmentId: string, options: { readonly payload: typeof EditRecurringRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof EditRecurring200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Change the recurring period
*/
readonly "editRecurringPeriod": <Config extends OperationConfig>(workspaceId: string, assignmentId: string, options: { readonly payload: typeof EditRecurringPeriodRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof EditRecurringPeriod200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Get total of users' capacity on workspace
*/
readonly "getUserTotals": <Config extends OperationConfig>(workspaceId: string, options: { readonly payload: typeof GetUserTotalsRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof GetUserTotals200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Get total capacity of a user
*/
readonly "getUserTotalsForSingleUser": <Config extends OperationConfig>(workspaceId: string, userId: string, options: { readonly params: typeof GetUserTotalsForSingleUserParams.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof GetUserTotalsForSingleUser200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Copy a scheduled assignment
*/
readonly "copyAssignment": <Config extends OperationConfig>(workspaceId: string, assignmentId: string, options: { readonly payload: typeof CopyAssignmentRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof CopyAssignment200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Find tags on a workspace
*/
readonly "getTags": <Config extends OperationConfig>(workspaceId: string, options: { readonly params?: typeof GetTagsParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetTags200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Add a new tag
*/
readonly "createNewTag": <Config extends OperationConfig>(workspaceId: string, options: { readonly payload: typeof CreateNewTagRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof CreateNewTag201.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Get a tag by ID
*/
readonly "getTag": <Config extends OperationConfig>(workspaceId: string, id: string, options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetTag200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Update a tag
*/
readonly "updateTag": <Config extends OperationConfig>(workspaceId: string, id: string, options: { readonly payload: typeof UpdateTagRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof UpdateTag200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Delete a tag
*/
readonly "deleteTag": <Config extends OperationConfig>(workspaceId: string, id: string, options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof DeleteTag200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Get all templates on a workspace
*/
readonly "getTemplates": <Config extends OperationConfig>(workspaceId: string, options: { readonly params?: typeof GetTemplatesParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetTemplates200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Create templates on a workspace
*/
readonly "createMany": <Config extends OperationConfig>(workspaceId: string, options: { readonly payload: typeof CreateManyRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof CreateMany200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Get template by ID on a workspace
*/
readonly "getTemplate": <Config extends OperationConfig>(workspaceId: string, templateId: string, options: { readonly params?: typeof GetTemplateParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetTemplate200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Delete a template
*/
readonly "delete1": <Config extends OperationConfig>(workspaceId: string, templateId: string, options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof Delete1200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Update a template
*/
readonly "update": <Config extends OperationConfig>(workspaceId: string, templateId: string, options: { readonly payload: typeof UpdateRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof Update200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Add a new time entry
*/
readonly "createTimeEntry": <Config extends OperationConfig>(workspaceId: string, options: { readonly payload: typeof CreateTimeEntryRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof CreateTimeEntry201.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Mark time entries as invoiced
*/
readonly "updateInvoicedStatus": <Config extends OperationConfig>(workspaceId: string, options: { readonly payload: typeof UpdateInvoicedStatusRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<void, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Get all in progress time entries on a workspace
*/
readonly "getInProgressTimeEntries": <Config extends OperationConfig>(workspaceId: string, options: { readonly params?: typeof GetInProgressTimeEntriesParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<void, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Get a specific time entry on a workspace
*/
readonly "getTimeEntry": <Config extends OperationConfig>(workspaceId: string, id: string, options: { readonly params?: typeof GetTimeEntryParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetTimeEntry200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Update time entry on a workspace
*/
readonly "updateTimeEntry": <Config extends OperationConfig>(workspaceId: string, id: string, options: { readonly payload: typeof UpdateTimeEntryRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof UpdateTimeEntry200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Delete a time entry from a workspace
*/
readonly "deleteTimeEntry": <Config extends OperationConfig>(workspaceId: string, id: string, options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<void, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Get balances for a policy
*/
readonly "getBalancesForPolicy": <Config extends OperationConfig>(workspaceId: string, policyId: string, options: { readonly params?: typeof GetBalancesForPolicyParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<void, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Update a balance
*/
readonly "updateBalance": <Config extends OperationConfig>(workspaceId: string, policyId: string, options: { readonly payload: typeof UpdateBalanceRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<void, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Get balance for a user
*/
readonly "getBalancesForUser": <Config extends OperationConfig>(workspaceId: string, userId: string, options: { readonly params?: typeof GetBalancesForUserParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<void, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Get policies on a workspace
*/
readonly "findPoliciesForWorkspace": <Config extends OperationConfig>(workspaceId: string, options: { readonly params?: typeof FindPoliciesForWorkspaceParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof FindPoliciesForWorkspace200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Create a time off policy
*/
readonly "createPolicy": <Config extends OperationConfig>(workspaceId: string, options: { readonly payload: typeof CreatePolicyRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof CreatePolicy201.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Get a time off policy
*/
readonly "getPolicy": <Config extends OperationConfig>(workspaceId: string, id: string, options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetPolicy200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Update a policy
*/
readonly "updatePolicy": <Config extends OperationConfig>(workspaceId: string, id: string, options: { readonly payload: typeof UpdatePolicyRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof UpdatePolicy200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Delete a policy
*/
readonly "deletePolicy": <Config extends OperationConfig>(workspaceId: string, id: string, options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<void, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Change a policy status
*/
readonly "updatePolicyStatus": <Config extends OperationConfig>(workspaceId: string, id: string, options: { readonly payload: typeof UpdatePolicyStatusRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof UpdatePolicyStatus200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Create a time off request
*/
readonly "createTimeOffRequest": <Config extends OperationConfig>(workspaceId: string, policyId: string, options: { readonly payload: typeof CreateTimeOffRequestRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof CreateTimeOffRequest200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Delete a time off request
*/
readonly "deleteTimeOffRequest": <Config extends OperationConfig>(workspaceId: string, policyId: string, requestId: string, options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof DeleteTimeOffRequest200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Change a time off request status
*/
readonly "changeTimeOffRequestStatus": <Config extends OperationConfig>(workspaceId: string, policyId: string, requestId: string, options: { readonly payload: typeof ChangeTimeOffRequestStatusRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof ChangeTimeOffRequestStatus200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Create a time off request for a user
*/
readonly "createTimeOffRequestForOther": <Config extends OperationConfig>(workspaceId: string, policyId: string, userId: string, options: { readonly payload: typeof CreateTimeOffRequestForOtherRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof CreateTimeOffRequestForOther200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Get all time off requests on a workspace
*/
readonly "getTimeOffRequest": <Config extends OperationConfig>(workspaceId: string, options: { readonly payload: typeof GetTimeOffRequestRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof GetTimeOffRequest200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Find all groups on a workspace
*/
readonly "getUserGroups": <Config extends OperationConfig>(workspaceId: string, options: { readonly params?: typeof GetUserGroupsParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetUserGroups200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Add a new group
*/
readonly "createUserGroup": <Config extends OperationConfig>(workspaceId: string, options: { readonly payload: typeof CreateUserGroupRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof CreateUserGroup201.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Update a group
*/
readonly "updateUserGroup": <Config extends OperationConfig>(workspaceId: string, id: string, options: { readonly payload: typeof UpdateUserGroupRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof UpdateUserGroup200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Delete a group
*/
readonly "deleteUserGroup": <Config extends OperationConfig>(workspaceId: string, id: string, options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof DeleteUserGroup200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Add users to a group
*/
readonly "addUser": <Config extends OperationConfig>(workspaceId: string, userGroupId: string, options: { readonly payload: typeof AddUserRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof AddUser200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Remove a user from a group
*/
readonly "deleteUser": <Config extends OperationConfig>(workspaceId: string, userGroupId: string, userId: string, options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof DeleteUser200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Get time entries for a user on a workspace
*/
readonly "getTimeEntries": <Config extends OperationConfig>(workspaceId: string, userId: string, options: { readonly params?: typeof GetTimeEntriesParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetTimeEntries200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Bulk edit time entries
*/
readonly "replaceMany": <Config extends OperationConfig>(workspaceId: string, userId: string, options: { readonly params?: typeof ReplaceManyParams.Encoded | undefined; readonly payload: typeof ReplaceManyRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof ReplaceMany200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Add a new time entry for another user on workspace
*/
readonly "createForOthers": <Config extends OperationConfig>(workspaceId: string, userId: string, options: { readonly params?: typeof CreateForOthersParams.Encoded | undefined; readonly payload: typeof CreateForOthersRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof CreateForOthers201.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Delete all time entries for a user on a workspace
*/
readonly "deleteMany": <Config extends OperationConfig>(workspaceId: string, userId: string, options: { readonly params: typeof DeleteManyParams.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof DeleteMany200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Stop a currently running timer on a workspace for a user
*/
readonly "stopRunningTimeEntry": <Config extends OperationConfig>(workspaceId: string, userId: string, options: { readonly payload: typeof StopRunningTimeEntryRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof StopRunningTimeEntry200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Duplicate a time entry
*/
readonly "duplicateTimeEntry": <Config extends OperationConfig>(workspaceId: string, userId: string, id: string, options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof DuplicateTimeEntry201.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Find all users on a workspace
*/
readonly "getUsersOfWorkspace": <Config extends OperationConfig>(workspaceId: string, options: { readonly params: typeof GetUsersOfWorkspaceParams.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof GetUsersOfWorkspace200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* You can add users to a workspace via API only if that workspace has a paid subscription. If the workspace has a paid subscription, you can add as many users as you want but you are limited by the number of paid user seats on that workspace.
*/
readonly "addUsers": <Config extends OperationConfig>(workspaceId: string, options: { readonly params: typeof AddUsersParams.Encoded; readonly payload: typeof AddUsersRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof AddUsers200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Filter workspace users
*/
readonly "filterUsersOfWorkspace": <Config extends OperationConfig>(workspaceId: string, options: { readonly payload: typeof FilterUsersOfWorkspaceRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof FilterUsersOfWorkspace200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Update a user's status
*/
readonly "updateUserStatus": <Config extends OperationConfig>(workspaceId: string, userId: string, options: { readonly payload: typeof UpdateUserStatusRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof UpdateUserStatus200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* This endpoint is not functional and has been deprecated. A user can be removed/deleted on the CAKE.com Account Members page after deactivating all their existing memberships on all workspaces within an organization.
*/
readonly "removeMember": <Config extends OperationConfig>(workspaceId: string, userId: string, options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof RemoveMember200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Update a user's cost rate
*/
readonly "setCostRateForUser": <Config extends OperationConfig>(workspaceId: string, userId: string, options: { readonly payload: typeof SetCostRateForUserRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof SetCostRateForUser200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Update a user's custom field
*/
readonly "upsertUserCustomFieldValue": <Config extends OperationConfig>(workspaceId: string, userId: string, customFieldId: string, options: { readonly payload: typeof UpsertUserCustomFieldValueRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof UpsertUserCustomFieldValue201.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Update a user's hourly rate
*/
readonly "setHourlyRateForUser": <Config extends OperationConfig>(workspaceId: string, userId: string, options: { readonly payload: typeof SetHourlyRateForUserRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof SetHourlyRateForUser200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Find user's team manager
*/
readonly "getManagersOfUser": <Config extends OperationConfig>(workspaceId: string, userId: string, options: { readonly params?: typeof GetManagersOfUserParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetManagersOfUser200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Give manager role to a user
*/
readonly "createUserRole": <Config extends OperationConfig>(workspaceId: string, userId: string, options: { readonly payload: typeof CreateUserRoleRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof CreateUserRole201.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Remove user's manager role
*/
readonly "deleteUserRole": <Config extends OperationConfig>(workspaceId: string, userId: string, options: { readonly payload: typeof DeleteUserRoleRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<void, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Get all webhooks on a workspace
*/
readonly "getWebhooks": <Config extends OperationConfig>(workspaceId: string, options: { readonly params?: typeof GetWebhooksParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetWebhooks200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Creating a webhook generates a new token which can be used to verify that the webhook being sent was sent by Clockify, as it will always be present in the header.
*/
readonly "createWebhook": <Config extends OperationConfig>(workspaceId: string, options: { readonly payload: typeof CreateWebhookRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof CreateWebhook201.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Get a specific webhook by id
*/
readonly "getWebhook": <Config extends OperationConfig>(workspaceId: string, webhookId: string, options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetWebhook200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Update a webhook
*/
readonly "updateWebhook": <Config extends OperationConfig>(workspaceId: string, webhookId: string, options: { readonly payload: typeof UpdateWebhookRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof UpdateWebhook200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Delete a webhook
*/
readonly "deleteWebhook": <Config extends OperationConfig>(workspaceId: string, webhookId: string, options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<void, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Get logs for a webhook
*/
readonly "getLogsForWebhook": <Config extends OperationConfig>(workspaceId: string, webhookId: string, options: { readonly params?: typeof GetLogsForWebhookParams.Encoded | undefined; readonly payload: typeof GetLogsForWebhookRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof GetLogsForWebhook200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Get webhook event statuses for a webhook
*/
readonly "getWebhookEventStatusesWithLatestLog": <Config extends OperationConfig>(workspaceId: string, webhookId: string, options: { readonly params?: typeof GetWebhookEventStatusesWithLatestLogParams.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GetWebhookEventStatusesWithLatestLog200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Generates a new webhook token and invalidates previous one
*/
readonly "generateNewToken": <Config extends OperationConfig>(workspaceId: string, webhookId: string, options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<typeof GenerateNewToken200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Response depends on report type and export type. Given example is for SUMMARY report and JSON exportType.
*
* Shared report data on FREE subscription plan is limited to a maximum interval length of one month (31 days).
*/
readonly "generateSharedReportV1": <Config extends OperationConfig>(id: string, options: { readonly params?: typeof GenerateSharedReportV1Params.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<void, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Generate an attendance report
*/
readonly "generateAttendanceReport": <Config extends OperationConfig>(workspaceId: string, options: { readonly payload: typeof GenerateAttendanceReportRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<void, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Detailed report data on FREE subscription plan is limited to a maximum interval length of one month (31 days).
*/
readonly "generateDetailedReport": <Config extends OperationConfig>(workspaceId: string, options: { readonly payload: typeof GenerateDetailedReportRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<void, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Expense report data on FREE subscription plan is limited to a maximum interval length of one month (31 days).
*/
readonly "generateDetailedReportV1": <Config extends OperationConfig>(workspaceId: string, options: { readonly payload: typeof GenerateDetailedReportV1RequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof GenerateDetailedReportV1200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Summary report data on FREE subscription plan is limited to a maximum interval length of one month (31 days).
*/
readonly "generateSummaryReport": <Config extends OperationConfig>(workspaceId: string, options: { readonly payload: typeof GenerateSummaryReportRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<void, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Weekly report data on FREE subscription plan is limited to a maximum interval length of one month (31 days).
*/
readonly "generateWeeklyReport": <Config extends OperationConfig>(workspaceId: string, options: { readonly payload: typeof GenerateWeeklyReportRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<void, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Gets all shared reports for current user on given workspace
*/
readonly "getSharedReportsV1": <Config extends OperationConfig>(workspaceId: string, options: { readonly params?: typeof GetSharedReportsV1Params.Encoded | undefined; readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<void, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Saves shared report with name, options and report filter.
*
* Shared report data on FREE subscription plan is limited to a maximum interval length of one month (31 days).
*/
readonly "saveSharedReportV1": <Config extends OperationConfig>(workspaceId: string, options: { readonly payload: typeof SaveSharedReportV1RequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<void, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Updates shared report name and/or options
*/
readonly "updateSharedReportV1": <Config extends OperationConfig>(workspaceId: string, id: string, options: { readonly payload: typeof UpdateSharedReportV1RequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<void, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Delete a shared report
*/
readonly "deleteSharedReportV1": <Config extends OperationConfig>(workspaceId: string, id: string, options: { readonly config?: Config | undefined } | undefined) => Effect.Effect<WithOptionalResponse<void, Config>, HttpClientError.HttpClientError | SchemaError>
  /**
* Generate an audit log report
*/
readonly "getAuditLogs": <Config extends OperationConfig>(workspaceId: string, options: { readonly payload: typeof GetAuditLogsRequestJson.Encoded; readonly config?: Config | undefined }) => Effect.Effect<WithOptionalResponse<typeof GetAuditLogs200.Type, Config>, HttpClientError.HttpClientError | SchemaError>
}

export interface ClockifyApiError<Tag extends string, E> {
  readonly _tag: Tag
  readonly request: HttpClientRequest.HttpClientRequest
  readonly response: HttpClientResponse.HttpClientResponse
  readonly cause: E
}

class ClockifyApiErrorImpl extends Data.Error<{
  _tag: string
  cause: any
  request: HttpClientRequest.HttpClientRequest
  response: HttpClientResponse.HttpClientResponse
}> {}

export const ClockifyApiError = <Tag extends string, E>(
  tag: Tag,
  cause: E,
  response: HttpClientResponse.HttpClientResponse,
): ClockifyApiError<Tag, E> =>
  new ClockifyApiErrorImpl({
    _tag: tag,
    cause,
    response,
    request: response.request,
  }) as any